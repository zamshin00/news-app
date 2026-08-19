import { signToken, parseBody } from '../lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST만 허용됩니다.' });
  }

  const { username, password } = parseBody(req);
  if (!username || !password) {
    return res.status(400).json({ error: '아이디와 비밀번호를 입력해주세요.' });
  }

  const adminUser = process.env.ADMIN_USERNAME;
  const adminPass = process.env.ADMIN_PASSWORD;

  if (!adminUser || !adminPass) {
    return res.status(500).json({ error: '관리자 계정이 서버에 설정되지 않았습니다.' });
  }

  if (username !== adminUser || password !== adminPass) {
    return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
  }

  // 관리자 세션은 12시간만 유지
  const token = signToken({ u: username, r: 'admin' }, 60 * 60 * 12);
  return res.status(200).json({ token, username });
}
