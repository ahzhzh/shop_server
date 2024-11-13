// index.ts
import express from 'express';
import mysql from 'mysql2/promise';
import cors from 'cors';
import { TextToSpeechClient } from '@google-cloud/text-to-speech';
import { SpeechClient } from '@google-cloud/speech';

import { GoogleGenerativeAI } from '@google/generative-ai';

import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


process.env.GOOGLE_APPLICATION_CREDENTIALS = path.join(__dirname, './key.json');




// db연동
const app = express();
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

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
  
});
// db 연동


//Gemini API 초기화
const genAI = new GoogleGenerativeAI('Your Google API Key');
const model = genAI.getGenerativeModel({ model : 'gemini-pro'});


// Google Cloud 클라이언트 초기화, Speech 클라이언트 초기화
// Google Cloud 클라이언트 초기화
const speechClient = new SpeechClient();
const ttsClient = new TextToSpeechClient();

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

app.post('/api/speech-to-text', async (req, res) => {
  try {
    // 1. 음성을 텍스트로 변환
    const transcription = await convertSpeechToText(req.body.audioData);
    console.log('Speech recognition result:', transcription);

    // 2. 기본 응답 객체 생성
    const responseData = {
      text: transcription,
      responseText: '',
      enhancedResponse: '',
      audioContent: '',
      action: '',
      product: null
    };

    // 3. 명령어 처리
    const orderMatch = transcription.match(/(.*?)\s*(주문|장바구니)/);
    if (orderMatch) {
      const [, productName, command] = orderMatch;
      
      // DB에서 상품 검색
      const [products] = await pool.query(
        'SELECT c_id, c_name, c_price FROM cpu_tb WHERE c_name LIKE ?',
        [`%${productName}%`]
      );

      if (products.length > 0) {
        const product = products[0];
        responseData.product = product;
        
        if (command === '장바구니') {
          responseData.responseText = `${product.c_name}을(를) 장바구니에 추가했습니다.`;
          responseData.action = 'ADD_TO_CART';
        } else {
          responseData.responseText = `${product.c_name}의 가격은 ${product.c_price}원 입니다.`;
          responseData.action = 'SHOW_PRICE';
        }

        // Gemini 응답 생성
        responseData.enhancedResponse = await generateGeminiResponse(`
          다음 상황에 대해 자연스러운 응답을 제공해주세요:
          상품명: ${product.c_name}
          가격: ${product.c_price}원
          요청: "${transcription}"
          수행된 작업: ${command === '장바구니' ? '장바구니 추가' : '가격 확인'}
        `);
      } else {
        responseData.responseText = "해당 상품을 찾을 수 없습니다.";
        responseData.enhancedResponse = "죄송합니다. 요청하신 상품을 찾을 수 없습니다. 다른 상품을 검색해보시겠어요?";
      }
    } else {
      responseData.responseText = "주문 명령을 인식하지 못했습니다.";
      responseData.enhancedResponse = await generateGeminiResponse(`
        다음 텍스트에 대해 분석하고 자연스러운 대화체로 응답해주세요: "${transcription}"
      `);
    }

    // 4. 음성 응답 생성
    responseData.audioContent = await convertTextToSpeech(responseData.enhancedResponse);

    // 5. 응답 전송
    res.json(responseData);

  } catch (error) {
    console.error('Speech-to-text error:', error);
    res.status(500).json({
      error: 'Processing failed',
      details: error.message
    });
  }
});



// STT (음성을 텍스트로 변환) API 엔드포인트
app.post('/api/speech-to-text', async (req, res) => {
  try {
    const audioBytes = req.body.audioData;
    
    const audio = {
      content: audioBytes,
    };
    const config = {
      encoding: 'LINEAR16',
      sampleRateHertz: 16000,
      languageCode: 'ko-KR',
    };
    const request = {
      audio: audio,
      config: config,
    };

    const [response] = await speechClient.recognize(request);
    // 음성 인식 결과 처리
    const transcription = response.results
      .map(result => result.alternatives[0].transcript)
      .join('\n');
    // 상품 이름 추출 (예: "XX 주문" 형식의 음성 명령 처리)
    const orderMatch = transcription.match(/(.*?)\s*주문/);
    if (orderMatch) {
      const productName = orderMatch[1];
      
      // 상품 검색
      const [rows] = await pool.query(
        'SELECT c_name, c_price FROM cpu_tb WHERE c_name LIKE ?',
        [`%${productName}%`]
      );

      if (rows.length > 0) {
        const product = rows[0];
        const responseText = `${product.c_name}의 가격은 ${product.c_price}원 입니다.`;
        res.json({ text: transcription, product: product, responseText: responseText });
      } else {
        res.json({ text: transcription, responseText: "해당 상품을 찾을 수 없습니다." });
      }
    } else {
      res.json({ text: transcription, responseText: "주문 명령을 인식하지 못했습니다." });
    }  
  } catch (error) {
    console.error('Speech-to-text error:', error);
    res.status(500).json({ error: 'Speech-to-text failed' });
  }

  
});

// TTS (텍스트를 음성으로 변환) API 엔드포인트
app.post('/api/text-to-speech', async (req, res) => {
  try {
    const text = req.body.text;
    
    const request = {
      input: { text: text },
      voice: { languageCode: 'ko-KR', ssmlGender: 'NEUTRAL' },
      audioConfig: { audioEncoding: 'MP3' },
    };

    const [response] = await ttsClient.synthesizeSpeech(request);
    res.send(response.audioContent);
  } catch (error) {
    console.error('Text-to-speech error:', error);
    res.status(500).json({ error: 'Text-to-speech failed' });
  }

  
});


// ... existing code ...
