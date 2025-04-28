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
  try {
    const [vgaProducts] = await pool.query('SELECT v_id, v_name, v_price FROM vga_tb');
    const [cpuProducts] = await pool.query('SELECT c_id, c_name, c_price FROM cpu_tb');
    
    res.json({
      vga: vgaProducts,
      cpu: cpuProducts
    });
  } catch (error) {
    console.error('Product fetch error:', error);
    res.status(500).json({ error: 'Product fetch failed' });
  }
});

app.get('/api/products/search', async (req, res) => {
  const productName = req.query.name;
  try {
    const [vgaProducts] = await pool.query(
      'SELECT v_id, v_name, v_price FROM vga_tb WHERE v_name LIKE ?',
      [`%${productName}%`]
    );
    const [cpuProducts] = await pool.query(
      'SELECT c_id, c_name, c_price FROM cpu_tb WHERE c_name LIKE ?',
      [`%${productName}%`]
    );
    
    res.json({
      vga: vgaProducts,
      cpu: cpuProducts
    });
  } catch (error) {
    console.error('Product search error:', error);
    res.status(500).json({ error: 'Product search failed' });
  }
});

//Gemini API 초기화
const genAI = new GoogleGenerativeAI('your api key');
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

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

// Gemini로 응답 생성하는 함수 수정
async function generateGeminiResponse(prompt) {
  try {
    // 모든 텍스트를 소문자로 변환하여 비교
    const lowerPrompt = prompt.toLowerCase();
    
    // 상품 정보 페이지 이동 명령어 처리
    if ((lowerPrompt.includes('정보') || lowerPrompt.includes('보여줘') || lowerPrompt.includes('알려줘') || lowerPrompt.includes('페이지')) 
        && (lowerPrompt.includes('상품') || lowerPrompt.includes('제품'))) {
      return "네, 해당 상품의 상세 정보 페이지로 이동하겠습니다.";
    }
    
    // 음성 인식 종료 명령어 처리
    if (prompt.includes('꺼 줘') || prompt.includes('종료') || prompt.includes('그만')) {
      return "네, 음성 인식을 종료하겠습니다.";
    }
    
    // 스크롤 관련 명령어 처리
    if (prompt.includes('스크롤') || prompt.includes('내려')) {
      return "네, 스크롤을 내리도록 하겠습니다.";
    }
    if (lowerPrompt.includes('위로') || lowerPrompt.includes('올려')) {
      return "네, 스크롤을 위로 올리도록 하겠습니다.";
    }
    
    // 뒤로가기 명령어 처리
    if (prompt.includes('뒤로') || prompt.includes('이전')) {
      return "네, 이전 페이지로 이동하겠습니다.";
    }
    
    // 결제 관련 명령어 처리
    if (lowerPrompt.includes('결제')) {
      if (lowerPrompt.includes('페이지') || lowerPrompt.includes('이동')) {
        return "네, 결제 페이지로 이동하겠습니다.";
      } else {
        return "네, 결제하겠습니다.";
      }
    }
    if (lowerPrompt.includes('주문') || lowerPrompt.includes('구매')) {
      if (lowerPrompt.includes('페이지') || lowerPrompt.includes('이동')) {
        return "네, 결제 페이지로 이동하겠습니다.";
      } else {
        return "네, 결제하겠습니다.";
      }
    }
    
    // NEW 섹션 명령어 처리
    if (lowerPrompt.includes('new') || lowerPrompt.includes('뉴') || lowerPrompt.includes('새로운')) {
      return "네, NEW 섹션으로 이동하겠습니다.";
    }
    
    // 인기 상품 섹션 명령어 처리
    if (lowerPrompt.includes('인기') || lowerPrompt.includes('인기상품') || lowerPrompt.includes('인기 상품')) {
      return "네, 인기 상품 섹션으로 이동하겠습니다.";
    }
    
    // 데이터베이스에서 상품 정보 가져오기
    const [vgaProducts] = await pool.query('SELECT v_id, v_name, v_price FROM vga_tb');
    const [cpuProducts] = await pool.query('SELECT c_id, c_name, c_price FROM cpu_tb');
    
    // 상품 정보를 문자열로 변환
    const vgaInfo = vgaProducts.map(p => 
      `[VGA] 상품명: ${p.v_name}, 가격: ${p.v_price}원`
    ).join('\n');
    
    const cpuInfo = cpuProducts.map(p => 
      `[CPU] 상품명: ${p.c_name}, 가격: ${p.c_price}원`
    ).join('\n');
    
    // Gemini에게 전달할 컨텍스트 생성
    const context = `다음은 현재 판매 중인 상품 목록입니다:\n\n${vgaInfo}\n\n${cpuInfo}\n\n사용자 질문: ${prompt}\n\n위 상품 목록을 참고하여 답변해주세요.`;
    
    // 기본 Gemini 응답 생성
    const result = await model.generateContent(context);
    return result.response.text();
  } catch (error) {
    console.error('Gemini response error:', error);
    return "죄송합니다. 응답 생성 중 오류가 발생했습니다.";
  }
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
                console.log('\n사용자: ', transcript); // 최종 음성 인식 결과
                const geminiResponse = await generateGeminiResponse(transcript);
                console.log('Gemini: ', geminiResponse); // Gemini 응답
                const audioContent = await convertTextToSpeech(geminiResponse);
                
                ws.send(JSON.stringify({
                  type: 'result',
                  transcript,
                  response: geminiResponse,
                  audio: audioContent,
                  shouldScroll: transcript.includes('스크롤') || transcript.includes('내려')
                }));
              } else {
                console.log('인식 중: ', transcript); // 중간 음성 인식 결과
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