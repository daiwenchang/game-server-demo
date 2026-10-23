const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const wss = new WebSocketServer({ port: 3000 });

// 所有连接：connId -> { ws, playerId }
const connections = new Map();

// 所有玩家：playerId -> { id, nickname, token }
const players = new Map();

// playerId -> connId
const playerConns = new Map();

// roomId -> { id, players: [playerId...], state }
const rooms = new Map();

// playerId -> roomId
const playerRooms = new Map();

let roomSeq = 1001;

let connSeq = 1;
let playerSeq = 1;

console.log('服务器启动，监听 3000 端口');

wss.on('connection', (ws) => {
  const connId = connSeq++;
  connections.set(connId, { ws, playerId: null });
  console.log(`[conn] 新连接 connId=${connId}`);

  ws.on('message', (raw) => {
    let msg;
    const conn = connections.get(connId); 
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      console.log(`[error] connId=${connId} 消息不是合法 JSON`);
      return;
    }

    if (msg.type === 'login') {
      const nickname = msg.data && msg.data.nickname;
      if (!nickname) {
        ws.send(JSON.stringify({ type: 'login_fail', data: { reason: '昵称不能为空' } }));
        return;
      }

      const playerId = playerSeq++;
      const token = crypto.randomBytes(16).toString('hex');

      const player = { id: playerId, 
        nickname, token, 
        online: true, 
        offlineAt: null,
        x: 400,
        y: 300,
        input: { dx: 0, dy: 0 }
      };
      players.set(playerId, player);

      // 把连接和玩家绑定
      conn.playerId = playerId;

      //绑定反向索引
      playerConns.set(playerId, connId);

      console.log(`[login] playerId=${playerId} nickname=${nickname}`);

      sendToPlayer(playerId, {
         type: 'login_ok',
         data: { playerId, token, nickname }
       });


      // ws.send(JSON.stringify({
      //   type: 'login_ok',
      //   data: { playerId, token, nickname }
      // }));
     }
     else if(msg.type == 'reconnect'){
        const playerId = msg.data &&msg.data.playerId;

        if(!playerId){
          console.log('playid无效');
          ws.send(JSON.stringify({ type: 'reconnect_fail', data: { reason: 'playerId 无效' } }));
          return;
        }

        const player = players.get(playerId);

        if (!player || !msg.data.token || msg.data.token !== player.token) {
          ws.send(JSON.stringify({ type: 'reconnect_fail', data: { reason: '玩家不存在或 token 无效' } }));
          return;
        }

        player.online = true;
        player.offlineAt = null;

        conn.playerId = playerId;
        playerConns.set(playerId, connId);

        // 如果玩家在房间里，恢复并通知
        const roomId = playerRooms.get(playerId);
        let roomInfo = null;

        if (roomId) {
          const room = rooms.get(roomId);
          if (room) {
            roomInfo = { roomId, players: room.players };

            for (const pid of room.players) {
              if (pid !== playerId) {
                sendToPlayer(pid, {
                  type: 'player_online',
                  data: { playerId }
                });
              }
            }
          }
        }

        console.log(`[reconnect] playerId=${playerId} connId=${connId} roomId=${roomId || '无'}`);

        sendToPlayer(playerId, {
          type: 'reconnect_ok',
          data: { playerId, nickname: player.nickname, room: roomInfo }
        });

     }else if (msg.type === 'create_room') {
        if (!conn.playerId) {
          ws.send(JSON.stringify({ type: 'error', data: { reason: '请先登录' } }));
          return;
        }

        const roomId = roomSeq++;
        const room = { id: roomId, players: [conn.playerId], state: 'WAITING' };
        rooms.set(roomId, room);
        playerRooms.set(conn.playerId, roomId);

        console.log(`[room] 创建 roomId=${roomId} by playerId=${conn.playerId}`);

        sendToPlayer(conn.playerId, {
          type: 'room_created',
          data: { roomId }
        });
      }else if (msg.type === 'join_room') {
        if (!conn.playerId) {
          ws.send(JSON.stringify({ type: 'error', data: { reason: '请先登录' } }));
          return;
        }

        const roomId = msg.data && msg.data.roomId;
        const room = rooms.get(roomId);

        if (!room) {
          ws.send(JSON.stringify({ type: 'error', data: { reason: '房间不存在' } }));
          return;
        }

        if (room.players.includes(conn.playerId)) {
          ws.send(JSON.stringify({ type: 'error', data: { reason: '你已经在房间里' } }));
          return;
        }

        room.players.push(conn.playerId);
        playerRooms.set(conn.playerId, roomId);

        console.log(`[room] playerId=${conn.playerId} 加入 roomId=${roomId}`);

        // 通知自己
        sendToPlayer(conn.playerId, {
          type: 'room_joined',
          data: { roomId, players: room.players }
        });

        // 通知房间里其他人
        for (const pid of room.players) {
          if (pid !== conn.playerId) {
            sendToPlayer(pid, {
              type: 'player_joined',
              data: { playerId: conn.playerId, nickname: players.get(conn.playerId).nickname }
            });
          }
        }
      }else if (msg.type === 'leave_room') {
        const roomId = playerRooms.get(conn.playerId);
        if (!roomId) return;

        const room = rooms.get(roomId);
        if (room) {
          room.players = room.players.filter(pid => pid !== conn.playerId);

          for (const pid of room.players) {
            sendToPlayer(pid, {
              type: 'player_left',
              data: { playerId: conn.playerId }
            });
          }

          if (room.players.length === 0) {
            rooms.delete(roomId);
            console.log(`[room] roomId=${roomId} 空房，销毁`);
          }
        }

        playerRooms.delete(conn.playerId);
        console.log(`[room] playerId=${conn.playerId} 离开 roomId=${roomId}`);
      } else if (msg.type === 'input') {
          if (!conn.playerId) return;

          const dx = msg.data && msg.data.dx;
          const dy = msg.data && msg.data.dy;

          // 简单校验：只允许 -1/0/1
          if (![-1, 0, 1].includes(dx) || ![-1, 0, 1].includes(dy)) {
            return;
          }

          const player = players.get(conn.playerId);
          if (player) {
            player.input = { dx, dy };
          }
      } else if (msg.type === 'chat') {
          if (!conn.playerId) return;

          const text = msg.data && msg.data.text;
          if (typeof text !== 'string' || text.trim() === '') return;
          if (text.length > 200) return;   // 简单长度限制

          const roomId = playerRooms.get(conn.playerId);
          if (!roomId) return;

          const player = players.get(conn.playerId);
          if (!player) return;

          broadcastToRoom(roomId, {
            type: 'chat',
            data: {
              playerId: conn.playerId,
              nickname: player.nickname,
              text: text.trim(),
              ts: Date.now()
            }
          });
        }else {
       console.log(`[error] connId=${connId} 未知消息类型 type=${msg.type}`);
     }

  });

  ws.on('close', () => {
    const conn = connections.get(connId);
    console.log(`[conn] connId=${connId} 断开，绑定玩家=${conn ? conn.playerId : '无'}`);

    if (conn && conn.playerId !== null) {
      const playerId = conn.playerId;

      if (playerConns.get(playerId) === connId) {
        playerConns.delete(playerId);
      }

      const player = players.get(playerId);
      if (player) {
        player.online = false;
        player.offlineAt = Date.now();

        // 如果在房间里，通知其他人
        const roomId = playerRooms.get(playerId);
        if (roomId) {
          const room = rooms.get(roomId);
          if (room) {
            for (const pid of room.players) {
              if (pid !== playerId) {
                sendToPlayer(pid, {
                  type: 'player_offline',
                  data: { playerId }
                });
              }
            }
          }
        }
      }
    }

    connections.delete(connId);
  });
});

const TICK_MS = 50;          // 20Hz
const SPEED_PER_SEC = 200;   // 每秒 200 单位
const SPEED_PER_TICK = SPEED_PER_SEC * (TICK_MS / 1000);  // 每帧 10 单位

let tickSeq = 0;

let lastTickAt = Date.now();

setInterval(() => {

  const now = Date.now();
  const delta = now - lastTickAt;
  lastTickAt = now;

  // 超过 80ms 说明 tick 漂移了
  if (delta > 80) {
    console.log(`[tick] 漂移 delta=${delta}ms`);
  }

  tickSeq++;

  for (const [roomId, room] of rooms) {
    if (room.players.length === 0) continue;

    // 1. 用输入更新每个玩家位置
    for (const pid of room.players) {
      const p = players.get(pid);
      if (!p) continue;

      p.x += p.input.dx * SPEED_PER_TICK;
      p.y += p.input.dy * SPEED_PER_TICK;

      // 简单边界，防止跑出画布
      p.x = Math.max(0, Math.min(800, p.x));
      p.y = Math.max(0, Math.min(600, p.y));
    }

    // 2. 广播房间状态
    const statePlayers = room.players
      .map(pid => players.get(pid))
      .filter(Boolean)
      .map(p => ({
        id: p.id,
        nickname: p.nickname,
        x: Math.round(p.x),
        y: Math.round(p.y),
        online: p.online
      }));

    broadcastToRoom(roomId, {
      type: 'state',
      data: { tick: tickSeq, players: statePlayers }
    });
  }
}, TICK_MS);


setInterval(() => {
  const now = Date.now();

  for (const [playerId, player] of players) {
    if (player.online === false && player.offlineAt && now - player.offlineAt > 15000) {
      console.log(`[timeout] playerId=${playerId} 离线超时，移除`);

      const roomId = playerRooms.get(playerId);
      if (roomId) {
        const room = rooms.get(roomId);
        if (room) {
          room.players = room.players.filter(pid => pid !== playerId);

          for (const pid of room.players) {
            sendToPlayer(pid, {
              type: 'player_left',
              data: { playerId }
            });
          }

          if (room.players.length === 0) {
            rooms.delete(roomId);
            console.log(`[room] roomId=${roomId} 空房，销毁`);
          }
        }
        playerRooms.delete(playerId);
      }

      players.delete(playerId);
    }
  }
}, 5000);

function broadcastToRoom(roomId, msg) {
  const room = rooms.get(roomId);
  if (!room) return;

  const raw = JSON.stringify(msg);   // 只序列化一次

  for (const pid of room.players) {
    sendToPlayer(pid, raw);          // 传字符串，sendToPlayer 不再序列化
  }
}

//发送消息
const MAX_BUFFERED = 1024 * 1024;   // 1MB，背压阈值

function sendToPlayer(playerId, msg) {
  const connId = playerConns.get(playerId);
  if (!connId) return;

  const conn = connections.get(connId);
  if (!conn || conn.ws.readyState !== 1) return;

  // 背压：这个客户端消费不过来，丢本帧，别把服务器拖死
  if (conn.ws.bufferedAmount > MAX_BUFFERED) return;

  // 对象就序列化，字符串就直接发
  const raw = typeof msg === 'string' ? msg : JSON.stringify(msg);
  conn.ws.send(raw);
}

//消息格式 json { "type": "login", "data": { "nickname": "Alice" } }