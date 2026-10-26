/** Minimal CDP client over node's net+crypto — no ws dependency. */
import net from 'node:net'
import crypto from 'node:crypto'

function maskInto(dst, src, mask) {
  for (let i = 0; i < src.length; i++) dst[i] = src[i] ^ mask[i & 3]
}

function frame(str) {
  const data = Buffer.from(str, 'utf8')
  const mask = crypto.randomBytes(4)
  const head = Buffer.allocUnsafe(2)
  head[0] = 0x81
  let lenBuf
  if (data.length < 126) {
    head[1] = 0x80 | data.length
    lenBuf = Buffer.alloc(0)
  } else if (data.length < 65536) {
    head[1] = 0x80 | 126
    lenBuf = Buffer.allocUnsafe(2)
    lenBuf.writeUInt16BE(data.length)
  } else {
    head[1] = 0x80 | 127
    lenBuf = Buffer.allocUnsafe(8)
    lenBuf.writeBigUInt64BE(BigInt(data.length))
  }
  const masked = Buffer.allocUnsafe(data.length)
  maskInto(masked, data, mask)
  return Buffer.concat([head, lenBuf, mask, masked])
}

export class CDP {
  constructor(wsUrl) {
    const u = new URL(wsUrl)
    this.pending = new Map()
    this.id = 0
    this.buf = Buffer.alloc(0)
    this.sessionId = undefined
    this.ready = new Promise((res, rej) => {
      this.sock = net.connect(Number(u.port), u.hostname)
      this.sock.on('error', rej)
      this.sock.on('connect', () => {
        const key = crypto.randomBytes(16).toString('base64')
        this.sock.write(
          `GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        )
      })
      let handshaken = false
      this.sock.on('data', (chunk) => {
        this.buf = Buffer.concat([this.buf, chunk])
        if (!handshaken) {
          const i = this.buf.indexOf('\r\n\r\n')
          if (i < 0) return
          this.buf = this.buf.subarray(i + 4)
          handshaken = true
          res()
        }
        this.drain()
      })
    })
  }

  drain() {
    for (;;) {
      if (this.buf.length < 2) return
      const b1 = this.buf[1]
      let len = b1 & 127
      let off = 2
      if (len === 126) {
        if (this.buf.length < 4) return
        len = this.buf.readUInt16BE(2)
        off = 4
      } else if (len === 127) {
        if (this.buf.length < 10) return
        len = Number(this.buf.readBigUInt64BE(2))
        off = 10
      }
      const masked = (b1 & 128) !== 0
      const moff = off + (masked ? 4 : 0)
      if (this.buf.length < moff + len) return
      let payload = this.buf.subarray(moff, moff + len)
      if (masked) {
        const m = this.buf.subarray(off, off + 4)
        const out = Buffer.allocUnsafe(len)
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ m[i & 3]
        payload = out
      }
      this.buf = this.buf.subarray(moff + len)
      let msg
      try {
        msg = JSON.parse(payload.toString('utf8'))
      } catch {
        continue
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej, timeout } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        clearTimeout(timeout)
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result)
      }
    }
  }

  send(method, params = {}, sessionId = this.sessionId) {
    const id = ++this.id
    return new Promise((res, rej) => {
      const timeout = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          rej(new Error('timeout ' + method))
        }
      }, 180000)
      this.pending.set(id, { res, rej, timeout })
      const msg = sessionId ? { id, method, params, sessionId } : { id, method, params }
      this.sock.write(frame(JSON.stringify(msg)))
    })
  }

  async evalIn(expr, sessionId) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
    }, sessionId)
    if (r?.exceptionDetails) {
      const d = r.exceptionDetails
      throw new Error((d.exception?.description || d.text || JSON.stringify(d)).slice(0, 600))
    }
    return r?.result?.value
  }

  close() {
    for (const { rej, timeout } of this.pending.values()) {
      clearTimeout(timeout)
      rej(new Error('CDP connection closed'))
    }
    this.pending.clear()
    try {
      this.sock?.destroy()
    } catch {}
  }
}

export async function connect(port = 9223) {
  const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())
  const page = list.find((t) => t.type === 'page')
  if (!page) throw new Error('no page target: ' + JSON.stringify(list.map((t) => t.type + ':' + t.url)))
  const cdp = new CDP(page.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Runtime.enable')
  return { cdp, page }
}
