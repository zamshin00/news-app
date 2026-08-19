import bcrypt from 'bcryptjs';
import { redis } from '../lib/redis.js';
import { signToken, parseBody } from '../lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST만 허용됩니다.' });
  }

  const { username, password } = parseBody(req);
  if (!username || !password) {
    return res.status(400).json({ error: '아이디와 비밀번호를 입력해주세요.' });
  }

  // 관리자 계정으로도 메인 로그인이 가능해야, 사용자가 하나도 없는 최초 상태에서
  // 관리자가 앱에 들어가 "사용자 등록" 화면을 쓸 수 있습니다.
  const adminUser = process.env.ADMIN_USERNAME;
  const adminPass = process.env.ADMIN_PASSWORD;
  if (adminUser && adminPass && username === adminUser && password === adminPass) {
    const token = signToken({ u: username, r: 'admin' }, 60 * 60 * 12); // 관리자 세션 12시간
    return res.status(200).json({ token, username, role: 'admin' });
  }

  try {
    const info = await redis.get(`user:${username}`);
    if (!info || !info.passwordHash) {
      return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    }

    const ok = await bcrypt.compare(password, info.passwordHash);
    if (!ok) {
      return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    }

    // 90일간 로그인 유지
    const token = signToken({ u: username, r: 'user' }, 60 * 60 * 24 * 90);
    return res.status(200).json({ token, username, role: 'user' });
  } catch (e) {
    return res.status(500).json({ error: '로그인 중 오류가 발생했습니다: ' + e.message });
  }
}
