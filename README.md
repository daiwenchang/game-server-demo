# 游戏服务器 Demo

一个从零手写的房间制联机游戏服务器 Demo，用于理解游戏服务器的核心机制：连接管理、玩家身份与重连、房间生命周期、固定频率状态同步、广播背压、压测。

技术栈刻意选最简单：**Node.js + ws + 浏览器原生 WebSocket + Canvas**，协议用 JSON，状态全内存。

---

## 目录结构

```text
game-demo/
  server/
    index.js        # 服务器入口：连接、登录、重连、房间、输入、聊天、帧循环
    package.json
  client/
    index.html      # 登录、房间、Canvas 渲染、键盘输入、聊天
  bot/
    bot.js          # 机器人压测脚本
    package.json
  README.md
```

---

## 启动

### 1. 服务器

```bash
cd server
npm install
node index.js
```

默认监听 `ws://localhost:3000`。

### 2. 客户端

直接用浏览器打开 `client/index.html`。开两个窗口（一个普通、一个无痕）可以模拟两个玩家。

### 3. 压测

```bash
cd bot
npm install
node bot.js
```

默认 50 个机器人，全部进同一个房间。改 `bot.js` 顶部的 `BOT_COUNT` 可以调整数量。

---

## 功能

- 登录，服务器返回 `playerId + token`
- 刷新/断线后凭 `playerId + token` 重连，恢复房间
- 创建房间、加入房间、主动离开房间
- 房间内 20Hz 状态广播，客户端 60Hz 渲染 + 插值
- 房间内聊天
- 掉线标记为离线、通知房间、15 秒超时移除
- 空房自动销毁
- 50 个机器人压测，无错误、无明显 tick 漂移

---

## 消息协议

统一格式：

```json
{ "type": "msg_type", "data": { } }
```

### 登录与重连

| 方向 | type | data | 说明 |
|---|---|---|---|
| C→S | `login` | `{nickname}` | 登录 |
| S→C | `login_ok` | `{playerId, token, nickname}` | 登录成功 |
| S→C | `login_fail` | `{reason}` | 登录失败 |
| C→S | `reconnect` | `{playerId, token}` | 重连 |
| S→C | `reconnect_ok` | `{playerId, nickname, room}` | 重连成功，`room` 为 `null` 或 `{roomId, players}` |
| S→C | `reconnect_fail` | `{reason}` | 重连失败，客户端应清 localStorage |

### 房间

| 方向 | type | data | 说明 |
|---|---|---|---|
| C→S | `create_room` | `{}` | 创建房间 |
| S→C | `room_created` | `{roomId}` | 创建成功 |
| C→S | `join_room` | `{roomId}` | 加入房间 |
| S→C | `room_joined` | `{roomId, players}` | 加入成功，`players` 是 playerId 数组 |
| S→C | `player_joined` | `{playerId, nickname}` | 通知房间内其他人 |
| C→S | `leave_room` | `{}` | 主动离开房间 |
| S→C | `player_left` | `{playerId}` | 通知房间内其他人 |

### 在线状态

| 方向 | type | data | 说明 |
|---|---|---|---|
| S→C | `player_offline` | `{playerId}` | 连接断开，标记离线，但保留房间位置 |
| S→C | `player_online` | `{playerId}` | 重连回来，恢复在线 |

### 游戏

| 方向 | type | data | 说明 |
|---|---|---|---|
| C→S | `input` | `{dx, dy}` | 移动输入，取值 -1/0/1 |
| S→C | `state` | `{tick, players: [{id, nickname, x, y, online}]}` | 20Hz 状态广播 |
| C→S | `chat` | `{text}` | 聊天，长度上限 200 |
| S→C | `chat` | `{playerId, nickname, text, ts}` | 聊天广播 |

### 错误

| 方向 | type | data | 说明 |
|---|---|---|---|
| S→C | `error` | `{reason}` | 通用错误，如未登录、房间不存在 |

---

## 服务器设计要点

### 连接与玩家分离

```js
connections  // connId -> { ws, playerId }
players      // playerId -> { id, nickname, token, online, offlineAt, x, y, input }
playerConns  // playerId -> connId
rooms        // roomId -> { id, players: [playerId...], state }
playerRooms  // playerId -> roomId
```

- `ws` 只存在于 `connections` 和最底层的 `sendToPlayer`。
- 房间只存 `playerId`，不持有 `ws`。
- 玩家可以没有连接（离线），连接也可以没有玩家（未登录）。

### 唯一发送出口

```js
sendToPlayer(playerId, msg)     // 对象自动序列化；字符串直接发
sendRawToPlayer(playerId, raw)  // 底层，含 bufferedAmount 背压检查
broadcastToRoom(roomId, msg)    // 只序列化一次，再逐 playerId 发送
```

**边界**：房间逻辑只调 `broadcastToRoom` 或 `sendToPlayer`，不直接碰 `ws`。以后多进程，只需替换 `sendToPlayer` 内部实现。

### 固定频率帧循环

```js
const TICK_MS = 50;          // 20Hz
const SPEED_PER_SEC = 200;
const SPEED_PER_TICK = SPEED_PER_SEC * (TICK_MS / 1000);
```

每 tick：

1. 按 `player.input` 更新位置，限制在 800×600 画布内。
2. 生成房间内所有玩家状态。
3. `broadcastToRoom` 广播 `state`。

`input` 不需要每帧清空：客户端按住方向键时保持输入，松开时发 `{dx:0,dy:0}`。

### 广播只序列化一次

```js
function broadcastToRoom(roomId, msg) {
  const room = rooms.get(roomId);
  if (!room) return;

  const raw = JSON.stringify(msg);   // 只序列化一次

  for (const pid of room.players) {
    sendToPlayer(pid, raw);
  }
}
```

初版是每个接收者序列化一次，500 人房间每 tick 序列化 500 次，GC 压力巨大，直接导致 tick 漂移和 OOM。改成只序列化一次后，GC 压力骤降。

### 发送背压

```js
const MAX_BUFFERED = 1024 * 1024;   // 1MB

if (conn.ws.bufferedAmount > MAX_BUFFERED) return;
```

`ws.send` 是异步的。消费慢的客户端会让服务器发送缓冲区无限堆积，最终撑爆 V8 堆。超过阈值就丢弃本帧广播，下一帧会拿到最新状态。实时游戏丢一帧比服务器 OOM 好得多。

### 离线保留与超时清理

- 连接断开：标记 `player.online = false`，记录 `offlineAt`，通知房间，**不删玩家、不删房间位置**。
- 重连成功：恢复 `online = true`，通知房间，返回 `room` 信息供客户端恢复界面。
- 超时清理：每 5 秒检查一次，离线超过 15 秒才真正移除玩家、更新房间、必要时销毁空房。
- 主动 `leave_room`：立刻移除并通知，不走超时。

### 房间生命周期

```text
创建 -> WAITING -> 有玩家 -> 玩家离线（保留） -> 重连恢复 / 超时移除 -> 空房销毁
```

---

## 客户端设计要点

- 登录成功后 `localStorage` 存 `playerId + token`。
- `ws.onopen` 时如果本地有 token，自动发 `reconnect`。
- `reconnect_fail` 清 localStorage，提示重新登录。
- 收到 `state` 不直接画，更新目标坐标；`requestAnimationFrame` 每帧做指数平滑插值（系数 0.3），让 20Hz 广播在 60Hz 渲染下平滑。
- 键盘输入用 `keydown/keyup` 维护按键集合，变化时发 `input`，不每帧发。
- Canvas 画 20×20 方块，自己红色、别人蓝色、离线灰色。

---

## 压测记录

| 场景 | 结果 |
|---|---|
| 50 bot 同房间，20Hz 全量广播 | 稳定，无错误，无 tick 漂移 |
| 500 bot 同房间，初版 | tick 漂移，最终 V8 堆 OOM |
| 500 bot 同房间，广播只序列化一次 + 背压 | 不 OOM，tick 漂移明显减少 |

### 500 bot OOM 的原因

1. 每 tick 对同一份状态序列化 500 次，每秒上万次 `JSON.stringify`，GC 来不及回收。
2. `ws.send` 无背压，消费慢的 bot 让发送缓冲区堆积到 GB 级。
3. 500 人全量广播消息体本身很大。

### 优化后结论

- 单进程 + 全量广播在 500 人同房间接近极限。
- 继续扩展需要 AOI、增量同步、降频、多进程分片，而不是继续调参。

---

## 已知限制

- **全内存**：服务器重启后玩家、房间、token 全部丢失。
- **单进程单线程**：所有房间共用一个事件循环，CPU 只用一核。
- **全量广播**：没有 AOI，房间内所有人都收全量状态。
- **无显式心跳消息**：依赖 WebSocket close 事件 + 离线超时，半开连接可能延迟发现。
- **退出登录不完整**：只清 localStorage，不通知服务器离房、不关闭连接。
- **无鉴权**：token 只是随机字符串，没有过期、没有多设备互踢。
- **无快照**：房间状态没有定期持久化，进程崩溃无法恢复。
- **无监控**：只有 `console.log`，没有指标、链路追踪、告警。

---

## 后续可扩展方向

按优先级：

1. **固定步长累积器**：把 `setInterval(50)` 改成固定步长 + 追帧上限，让逻辑时间稳定。
2. **输入队列**：网络回调只入队，tick 统一消费，为限流、合并、多进程做准备。
3. **SQLite/MySQL**：先只存账号和对局结算，房间状态仍内存。
4. **Redis**：存会话、路由、排行榜。
5. **显式心跳**：客户端定时发 `heartbeat`，服务器检测半开连接。
6. **快照 + 恢复**：定期把房间状态写到 Redis/文件，重启可恢复。
7. **AOI / 增量同步**：大房间只广播视野内、只发变化字段。
8. **多进程分片**：网关与房间进程分离，按 `roomId` 哈希分片，Redis 存路由。

---

## 这个 Demo 验证了什么

- 连接与玩家分离，重连可以换连接不换身份。
- 房间只认 `playerId`，广播走统一出口，为多进程留好边界。
- 20Hz 服务器广播 + 60Hz 客户端插值，小房间观感流畅。
- 离线保留 + 超时清理，刷新页面不丢房间。
- 广播只序列化一次 + 背压检查，是单进程全量广播不 OOM 的必要条件。
- 压测能真实暴露 GC、发送缓冲、tick 漂移这些“单进程小房间看不出来”的问题。
