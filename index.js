import express from 'express';
import mysql from 'mysql2/promise';
import cors from 'cors';
import { TextToSpeechClient } from '@google-cloud/text-to-speech';
import { SpeechClient } from '@google-cloud/speech';
import { GoogleGenerativeAI } from '@google/generative-ai';
import path from 'path';
import { fileURLToPath } from 'url';
import {WebSocketServer} from 'ws';
import { createServer } from 'http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

process.env.GOOGLE_APPLICATION_CREDENTIALS = path.join(__dirname, './key.json');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

const port = 3001;

const pool = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: '',
  database: 'danawa_cpu'
});

app.use(cors());
app.use(express.json({ limit: '50mb'}));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// 상품 목록 조회 API
app.get('/api/products', async (req, res) => {
  const [rows] = await pool.query('SELECT c_id, c_name, c_price FROM cpu_tb');
  res.json(rows);
});

app.get('/api/products/search', async (req, res) => {
  const productName = req.query.name;
  try {
    const [rows] = await pool.query(
      'SELECT c_id, c_name, c_price FROM cpu_tb WHERE c_name LIKE ?',
      [`%${productName}%`]
    );
    res.json(rows);
  } catch (error) {
    console.error('Product search error:', error);
    res.status(500).json({ error: 'Product search failed' });
  }
});

//Gemini API 초기화
const genAI = new GoogleGenerativeAI('your gemini key');
const model = genAI.getGenerativeModel({ model : 'gemini-pro'});

// Google Cloud 클라이언트 초기화
const speechClient = new SpeechClient();
const ttsClient = new TextToSpeechClient();

// 음성을 텍스트로 변환하는 함수
async function convertSpeechToText(audioData) {
  const [response] = await speechClient.recognize({
    audio: { content: audioData },
    config: {
      encoding: 'WEBM_OPUS',
      sampleRateHertz: 48000,
      languageCode: 'ko-KR',
    },
  });
  return response.results.map(result => result.alternatives[0].transcript).join('\n');
}

// 텍스트를 음성으로 변환하는 함수
async function convertTextToSpeech(text) {
  const [response] = await ttsClient.synthesizeSpeech({
    input: { text },
    voice: { languageCode: 'ko-KR', ssmlGender: 'NEUTRAL' },
    audioConfig: { audioEncoding: 'MP3' },
  });
  return response.audioContent.toString('base64');
}

// Gemini로 응답 생성하는 함수
async function generateGeminiResponse(prompt) {
  const result = await model.generateContent(prompt);
  return result.response.text();
}

// 스트리밍 STT 설정
const streamingConfig = {
  config: {
    encoding: 'LINEAR16',
    sampleRateHertz: 48000,
    languageCode: 'ko-KR',
    enableAutomaticPunctuation: true,
    model: 'default',
    useEnhanced: true

  },
  interimResults: true,
};

wss.on('connection', (ws) => {
  console.log('New WebSocket connection');
  let recognizeStream = null;

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message.toString());
      

      if (data.type === 'start') {
        console.log('\n=== 음성 인식 시작 ===');
        recognizeStream = speechClient
          .streamingRecognize(streamingConfig)
          .on('error', (error) => {
            console.error('STT stream error:', error);
            ws.send(JSON.stringify({ type: 'error', message: error.message }));
          })
          .on('data', async (data) => {
            if (data.results[0] && data.results[0].alternatives[0]) {
              const transcript = data.results[0].alternatives[0].transcript;
              
              if (data.results[0].isFinal) {
                console.log('\n🎤 최종 인식 결과:', transcript);
                const geminiResponse = await generateGeminiResponse(transcript);
                console.log('🤖 Gemini 응답:', geminiResponse);
                const audioContent = await convertTextToSpeech(geminiResponse);
                
                ws.send(JSON.stringify({
                  type: 'result',
                  transcript,
                  response: geminiResponse,
                  audio: audioContent
                }));
              } else {
                console.log('🎤 인식 중...:', transcript);
                ws.send(JSON.stringify({
                  type: 'interim',
                  transcript
                }));
              }
            }
          });
      } else if (data.type === 'audio') {
        if (recognizeStream) {
          recognizeStream.write(Buffer.from(data.audio, 'base64'));
          
        }
      } else if (data.type === 'stop') {
        console.log('=== 음성 인식 종료 ===\n');
        if (recognizeStream) {
          recognizeStream.end();
          recognizeStream = null;
        }
      }
    } catch (error) {
      console.error('WebSocket error:', error);
      ws.send(JSON.stringify({ type: 'error', message: error.message }));
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    if (recognizeStream) {
      recognizeStream.end();
      recognizeStream = null;
    }
  });

  // 연결 상태 확인을 위한 ping/pong
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });
});

// 연결 상태 주기적 확인
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => {
  clearInterval(interval);
});

// 서버 시작
server.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});