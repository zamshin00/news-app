import crypto from 'crypto';

const SECRET = process.env.SESSION_SECRET || '';

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf8');
}

// role: 'user' | 'admin'
export function signToken(payload, ttlSeconds = 60 * 60 * 24 * 90) {
  const body = { ...payload, exp: Date.now() + ttlSeconds * 1000 };
  const payloadB64 = base64url(JSON.stringify(body));
  const sig = crypto.createHmac('sha256', SECRET).update(payloadB64).digest('hex');
  return `${payloadB64}.${sig}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payloadB64, sig] = token.split('.');
  if (!payloadB64 || !sig) return null;
  const expectedSig = crypto.createHmac('sha256', SECRET).update(payloadB64).digest('hex');
  const sigBuf = Buffer.from(sig, 'hex');
  const expBuf = Buffer.from(expectedSig, 'hex');
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  let payload;
  try {
    payload = JSON.parse(base64urlDecode(payloadB64));
  } catch {
    return null;
  }
  if (!payload.exp || Date.now() > payload.exp) return null;
  return payload;
}

export function getBearerToken(req) {
  const h = req.headers['authorization'] || req.headers['Authorization'];
  if (!h) return null;
  const m = String(h).match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

// role이 주어지면 해당 role만 허용, 없으면 로그인만 되어있으면 통과(user/admin 둘 다 허용)
export function requireAuth(req, res, role) {
  const token = getBearerToken(req);
  const payload = verifyToken(token);
  if (!payload) {
    res.status(401).json({ error: '로그인이 필요합니다.' });
    return null;
  }
  if (role && payload.r !== role) {
    res.status(403).json({ error: '권한이 없습니다.' });
    return null;
  }
  return payload;
}

export function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return {};
}
