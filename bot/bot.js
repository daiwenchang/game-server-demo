const WebSocket = require('ws');

const SERVER = 'ws://localhost:3000';
const BOT_COUNT = 500;
const INPUT_MS = 100;      // 每个 bot 每 100ms 发一次输入
const CHAT_MS = 5000;      // 每 5 秒发一次聊天
const CONNECT_INTERVAL = 50; // 分批连接，避免瞬间冲击

let roomId = null;
let started = 0;

const stats = {
  connected: 0,
  loggedIn: 0,
  joinedRoom: 0,
  stateReceived: 0,
  chatReceived: 0,
  errors: 0
};

function createBot(index) {
  const ws = new WebSocket(SERVER);
  const nickname = `bot${index}`;

  ws.on('open', () => {
    stats.connected++;
    ws.send(JSON.stringify({ type: 'login', data: { nickname } }));
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === 'login_ok') {
      stats.loggedIn++;
      if (index === 0) {
        ws.send(JSON.stringify({ type: 'create_room', data: {} }));
      } else {
        waitForRoomId().then(rid => {
          if (rid) {
            ws.send(JSON.stringify({ type: 'join_room', data: { roomId: rid } }));
          }
        });
      }
    } else if (msg.type === 'room_created') {
      roomId = msg.data.roomId;
      stats.joinedRoom++;
      console.log(`[bot0] 创建房间 roomId=${roomId}`);
      startLoop(ws, index);
      started++;
    } else if (msg.type === 'room_joined') {
      stats.joinedRoom++;
      startLoop(ws, index);
      started++;
    } else if (msg.type === 'state') {
      stats.stateReceived++;
    } else if (msg.type === 'chat') {
      stats.chatReceived++;
    } else if (msg.type === 'error') {
      stats.errors++;
    }
  });

  ws.on('error', () => {
    stats.errors++;
  });

  ws.on('close', () => {
    // 压测期间不重连
  });
}

function waitForRoomId() {
  return new Promise((resolve) => {
    const check = () => {
      if (roomId) resolve(roomId);
      else setTimeout(check, 100);
    };
    check();
  });
}

function startLoop(ws, index) {
  // 发输入：随机方向，模拟移动
  setInterval(() => {
    if (ws.readyState !== 1) return;
    const dx = Math.floor(Math.random() * 3) - 1;
    const dy = Math.floor(Math.random() * 3) - 1;
    ws.send(JSON.stringify({ type: 'input', data: { dx, dy } }));
  }, INPUT_MS);

  // 每 10 个 bot 里只有 1 个发聊天，避免刷屏
  if (index % 10 === 0) {
    setInterval(() => {
      if (ws.readyState !== 1) return;
      ws.send(JSON.stringify({ type: 'chat', data: { text: `我是 bot${index}` } }));
    }, CHAT_MS);
  }
}

async function main() {
  console.log(`启动 ${BOT_COUNT} 个机器人，目标 ${SERVER}`);

  for (let i = 0; i < BOT_COUNT; i++) {
    createBot(i);
    await new Promise(r => setTimeout(r, CONNECT_INTERVAL));
  }

  console.log('所有机器人已发起连接，等待进房...');

  setInterval(() => {
    console.log(
      `[stats] 连接=${stats.connected} 登录=${stats.loggedIn} 进房=${stats.joinedRoom} ` +
      `state=${stats.stateReceived} chat=${stats.chatReceived} 错误=${stats.errors}`
    );
  }, 5000);
}

main();