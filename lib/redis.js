import { Redis } from '@upstash/redis';

// Vercel의 KV_REST_API_URL / KV_REST_API_TOKEN 환경변수를 자동으로 읽습니다.
export const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});
