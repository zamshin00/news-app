import bcrypt from 'bcryptjs';
import { redis } from '../lib/redis.js';
import { requireAuth, parseBody } from '../lib/auth.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  const admin = requireAuth(req, res, 'admin');
  if (!admin) return; // requireAuth가 이미 401/403 응답을 보냄

  try {
    if (req.method === 'GET') {
      const usernames = (await redis.smembers('users:index')) || [];
      const users = [];
      for (const uname of usernames) {
        const info = await redis.get(`user:${uname}`);
        users.push({ username: uname, name: info?.name || '', createdAt: info?.createdAt || null });
      }
      users.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      return res.status(200).json({ users });
    }

    if (req.method === 'POST') {
      const { username, password, name } = parseBody(req);
      if (!username || !password || !name) {
        return res.status(400).json({ error: '이름, 아이디, 비밀번호를 모두 입력해주세요.' });
      }
      if (password.length < 4) {
        return res.status(400).json({ error: '비밀번호는 4자 이상이어야 합니다.' });
      }
      const exists = await redis.sismember('users:index', username);
      if (exists) {
        return res.status(409).json({ error: '이미 존재하는 아이디입니다.' });
      }
      const passwordHash = await bcrypt.hash(password, 10);
      await redis.set(`user:${username}`, { passwordHash, name, createdAt: Date.now() });
      await redis.sadd('users:index', username);
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'DELETE') {
      const { username } = parseBody(req);
      if (!username) {
        return res.status(400).json({ error: '아이디를 입력해주세요.' });
      }
      await redis.del(`user:${username}`);
      await redis.srem('users:index', username);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: '지원하지 않는 메서드입니다.' });
  } catch (e) {
    return res.status(500).json({ error: '처리 중 오류가 발생했습니다: ' + e.message });
  }
}
