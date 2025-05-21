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

// 전역 변수로 상품 정보 저장
let productData = {};

const pool = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: '', // 실제 환경에서는 보안을 위해 비밀번호를 설정하고 환경 변수 등을 사용하세요.
  database: 'danawa_cpu'
});

app.use(cors());
app.use(express.json({ limit: '50mb'}));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// 서버 시작 시 상품 정보 로드
async function loadProductData() {
  try {
    // 모든 테이블 이름 조회
    const [tables] = await pool.query('SHOW TABLES');
    const tableNames = tables.map(table => Object.values(table)[0]);
    
    // 각 테이블의 데이터 로드
    for (const tableName of tableNames) {
      const [data] = await pool.query(`SELECT * FROM ${tableName}`);
      productData[tableName] = data;
    }
    
    console.log('모든 상품 정보 로드 완료:', Object.keys(productData));
  } catch (error) {
    console.error('상품 정보 로드 실패:', error);
  }
}

// 서버 시작 시 상품 정보 로드
loadProductData();

// 모든 테이블 데이터 조회 API
app.get('/api/tables', async (req, res) => {
  try {
    const [tables] = await pool.query('SHOW TABLES');
    const tableNames = tables.map(table => Object.values(table)[0]);
    
    const tableData = {};
    for (const tableName of tableNames) {
      const [data] = await pool.query(`SELECT * FROM ${tableName}`);
      tableData[tableName] = data;
    }
    
    res.json(tableData);
  } catch (error) {
    console.error('Table data fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch table data' });
  }
});

// 특정 테이블 데이터 조회 API
app.get('/api/tables/:tableName', async (req, res) => {
  try {
    const { tableName } = req.params;
    const [data] = await pool.query(`SELECT * FROM ${tableName}`);
    res.json(data);
  } catch (error) {
    console.error('Table data fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch table data' });
  }
});

// 상품 목록 조회 API
app.get('/api/products', async (req, res) => {
  try {
    res.json(productData);
  } catch (error) {
    console.error('Product fetch error:', error);
    res.status(500).json({ error: 'Product fetch failed' });
  }
});

app.get('/api/products/search', async (req, res) => {
  const productName = req.query.name;
  try {
    const [vgaProducts] = await pool.query(
      'SELECT v_name, v_price FROM vga_tb WHERE v_name LIKE ?',
      [`%${productName}%`]
    );
    const [cpuProducts] = await pool.query(
      'SELECT c_name, c_price FROM cpu_tb WHERE c_name LIKE ?',
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
const genAI = new GoogleGenerativeAI('your key'); 
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

// 대화 기록을 저장할 Map
const conversationHistory = new Map();
// 제품 상태를 저장할 Map
const productStates = new Map();

// 대화 기록 관리 함수
function getConversationHistory(ws) {
  if (!conversationHistory.has(ws)) {
    conversationHistory.set(ws, []);
  }
  return conversationHistory.get(ws);
}

// 대화 기록 추가 함수
function addToConversationHistory(ws, userMessage, aiResponse) {
  const history = getConversationHistory(ws);
  history.push({
    user: userMessage,
    ai: aiResponse,
    timestamp: new Date().toISOString()
  });
  if (history.length > 10) { // 최근 10개 대화만 유지
    history.shift();
  }
}

// Gemini로 응답 생성하는 함수 (수정됨)
async function generateGeminiResponse(prompt, ws) {
  try {
    const history = getConversationHistory(ws);
    const lowerPrompt = prompt.toLowerCase();
    
    const productState = productStates.get(ws);
    
    let currentProductsInfo = '';
    if (productState && productState.currentProducts && productState.currentProducts.length > 0) {
      currentProductsInfo = productState.currentProducts
        .map(([id, product]) => {
          if (!product) return '';
          const name = product.name || '이름 없음';
          const price = product.price ? product.price.toLocaleString() : '가격 정보 없음';
          const category = product.category || '상품';
          return `[${category}] 상품명: ${name}, 가격: ${price}원`;
        })
        .filter(info => info !== '')
        .join('\n');
    }
    
    const allProductsInfo = Object.entries(productData)
      .map(([tableName, products]) => {
        if (!Array.isArray(products)) return '';
        const tableInfo = products.map(p => {
          if (!p) return '';
          const name = p[`${tableName.split('_')[0]}_name`] || p.name || '이름 없음';
          const price = p[`${tableName.split('_')[0]}_price`] || p.price;
          const priceStr = price ? price.toLocaleString() : '가격 정보 없음';
          return `[${tableName.toUpperCase()}] 상품명: ${name}, 가격: ${priceStr}원`;
        })
        .filter(info => info !== '')
        .join('\n');
        return tableInfo;
      })
      .filter(info => info !== '')
      .join('\n\n');
    
    const conversationContext = history
      .map(entry => `사용자: ${entry.user}\nAI: ${entry.ai}`)
      .join('\n');
    
    let baseContext = `이전 대화 내용:\n${conversationContext}\n\n`; // const를 let으로 변경
    
    if (currentProductsInfo) {
      baseContext += `현재 표시된 제품 목록:\n${currentProductsInfo}\n\n`;
    }
    
    baseContext += `전체 상품 목록:\n${allProductsInfo}\n\n사용자 질문: ${prompt}\n\n`;
    
    if (lowerPrompt.includes('가격') || lowerPrompt.includes('얼마') || 
        lowerPrompt.includes('정보') || lowerPrompt.includes('상품') ||
        lowerPrompt.includes('비싼') || lowerPrompt.includes('최고가') ||
        lowerPrompt.includes('추천') || lowerPrompt.includes('어떤') ||
        lowerPrompt.includes('뭐가') || lowerPrompt.includes('뭐야')) {
      
      if (currentProductsInfo) {
        const context = `${baseContext}현재 표시된 제품 목록을 기반으로 답변해주세요. 친근하게 답변해주세요.`;
        const result = await model.generateContent(context + "답변은 2-3문장으로 간단하게 해주세요.");
        return result.response.text();
      }
      
      const context = `${baseContext}전체 상품 목록을 기반으로 답변해주세요. 친근하게 답변해주세요.`;
      const result = await model.generateContent(context + "답변은 2-3문장으로 간단하게 해주세요.");
      return result.response.text();
    }
    
    if (lowerPrompt.includes('장바구니')) {
      if (lowerPrompt.includes('열어 줘') || lowerPrompt.includes('보여 줘') || 
          lowerPrompt.includes('확인') || lowerPrompt.includes('이동')) {
        return "네, 장바구니 페이지로 이동하겠습니다.";
      }
    }
    
    if (lowerPrompt.includes('전체') && lowerPrompt.includes('카테고리')) {
      if (lowerPrompt.includes('보여 줘') || lowerPrompt.includes('열어 줘') || 
          lowerPrompt.includes('이동') || lowerPrompt.includes('가줘')) {
        return "네, 전체 카테고리로 이동하겠습니다.";
      }
    }
    
    if (prompt.includes('꺼 줘') || prompt.includes('종료') || prompt.includes('그만')) {
      return "네, 음성 인식을 종료하겠습니다.";
    }
    
    if (prompt.includes('스크롤') || prompt.includes('내려')) {
      return "네, 스크롤을 내리도록 하겠습니다.";
    }
    if (lowerPrompt.includes('위로') || lowerPrompt.includes('올려')) {
      return "네, 스크롤을 위로 올리도록 하겠습니다.";
    }
    
    if (prompt.includes('뒤로') || prompt.includes('이전')) {
      return "네, 이전 페이지로 이동하겠습니다.";
    }
    
    if (lowerPrompt.includes('체크') || lowerPrompt.includes('확인해') || lowerPrompt.includes('확인해줘')) {
      return "네, 알겠습니다.";
    }
    
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
    
    const context = `${baseContext}일반적인 대화입니다. 친근하게 답변해주세요.`;
    const result = await model.generateContent(context + "답변은 2-3문장으로 간단하게 해주세요.");
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
      
      if (data.type === 'productState') {
        // 상품 목록 로그 출력
        console.log('클라이언트에서 전달받은 상품 목록:', data.currentProducts);
        productStates.set(ws, {
          currentProducts: data.currentProducts,
          selectedFilters: data.selectedFilters,
          currentCategory: data.currentCategory
        });
        return;
      }
      
      if (data.type === 'start') {
        console.log('\n=== 음성 인식 시작 ===');
        recognizeStream = speechClient
          .streamingRecognize(streamingConfig)
          .on('error', (error) => {
            console.error('STT stream error:', error);
            ws.send(JSON.stringify({ type: 'error', message: error.message }));
          })
          .on('data', async (streamData) => { // 변수명 data가 중복되므로 streamData로 변경
            if (streamData.results[0] && streamData.results[0].alternatives[0]) {
              const transcript = streamData.results[0].alternatives[0].transcript;
              
              if (streamData.results[0].isFinal) {
                console.log('\n사용자: ', transcript);
                const geminiResponse = await generateGeminiResponse(transcript, ws);
                console.log('Gemini: ', geminiResponse);
                
                addToConversationHistory(ws, transcript, geminiResponse);
                
                const audioContent = await convertTextToSpeech(geminiResponse);
                
                ws.send(JSON.stringify({
                  type: 'result',
                  transcript,
                  response: geminiResponse,
                  audio: audioContent,
                  shouldScroll: transcript.includes('스크롤') || transcript.includes('내려')
                }));
              } else {
                console.log('인식 중: ', transcript);
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
    conversationHistory.delete(ws);
    productStates.delete(ws);
    if (recognizeStream) {
      recognizeStream.end();
      recognizeStream = null;
    }
  });

  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });
});

const interval = setInterval(() => {
  wss.clients.forEach((wsClient) => { // 변수명 ws가 중복되므로 wsClient로 변경
    if (wsClient.isAlive === false) return wsClient.terminate();
    wsClient.isAlive = false;
    wsClient.ping();
  });
}, 30000);

wss.on('close', () => {
  clearInterval(interval);
});

server.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});