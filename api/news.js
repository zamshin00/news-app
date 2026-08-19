export default async function handler(req, res) {
  const { query, display, start, sort, clientId, clientSecret, type, sites, naverEnabled } = req.query;

  // 보험사 목록 자동 조회 (손해보험협회 + 생명보험협회 공식 정회원사 명단, 실패 시 나무위키 대체)
  if (type === 'company_sync') {
    const result = { sonbo: null, saengbo: null, sonboSource: 'official', saengboSource: 'official' };
    try {
      result.sonbo = await fetchKniaSonbo();
    } catch (e1) {
      try {
        result.sonbo = (await fetchNamuwikiBoth()).sonbo;
        result.sonboSource = 'namuwiki';
      } catch (e2) {
        return res.status(200).json({ error: `손보사 명단 조회 실패 (공식+나무위키 모두 실패): ${e2.message}` });
      }
    }
    try {
      result.saengbo = await fetchKliaSaengbo();
    } catch (e1) {
      try {
        result.saengbo = (await fetchNamuwikiBoth()).saengbo;
        result.saengboSource = 'namuwiki';
      } catch (e2) {
        return res.status(200).json({ error: `생보사 명단 조회 실패 (공식+나무위키 모두 실패): ${e2.message}` });
      }
    }
    return res.status(200).json(result);
  }

  // RSS 자동 감지
  if (type === 'rss_detect') {
    try {
      const siteUrl = req.query.siteUrl;
      const rssUrl = await detectRss(siteUrl);
      return res.status(200).json({ rssUrl });
    } catch(e) {
      return res.status(200).json({ rssUrl: null });
    }
  }

  if (!query || !clientId || !clientSecret) {
    return res.status(400).json({ error: '필수 파라미터가 없습니다.' });
  }

  // 웹문서 검색 (신문사 홈페이지 찾기용)
  if (type === 'webkr') {
    try {
      const p = new URLSearchParams({ query, display: display || 10, start: start || 1 });
      const r = await fetch(`https://openapi.naver.com/v1/search/webkr.json?${p}`, {
        headers: { 'X-Naver-Client-Id': clientId, 'X-Naver-Client-Secret': clientSecret }
      });
      const data = await r.json();
      return res.status(200).json(data);
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  try {
    // 1) 네이버 뉴스 API 검색
    const naverItems = naverEnabled === '0' ? [] : await searchNaver({ query, display: display || 100, start: start || 1, sort: sort || 'date', clientId, clientSecret });

    // 2) 개별 사이트 검색
    const siteStatuses = []; // 사이트별 상태 추적
    let siteItems = [];

    if (sites) {
      const siteList = JSON.parse(sites);
      const siteSearches = siteList.map(async site => {
        if (site.rssUrl) {
          // RSS 검색
          const result = await searchRss({ rssUrl: site.rssUrl, query, siteName: site.name, siteDomain: site.domain });
          siteStatuses.push({ name: site.name, type: 'rss', ok: true });
          return result;
        } else if (site.crawl) {
          // 크롤링 검색 (사용자가 선택한 경우)
          const result = await searchCrawl({ siteUrl: site.url, query, siteName: site.name, siteDomain: site.domain });
          siteStatuses.push({ name: site.name, type: 'crawl', ok: result.ok, error: result.error });
          return result.items;
        } else {
          // 웹검색 (네이버 site: 쿼리)
          const result = await searchNaverWeb({ query: `${query} site:${site.domain}`, display: 20, clientId, clientSecret, siteName: site.name, siteDomain: site.domain });
          siteStatuses.push({ name: site.name, type: 'web', ok: true });
          return result;
        }
      });
      const results = await Promise.allSettled(siteSearches);
      results.forEach(r => {
        if (r.status === 'fulfilled') siteItems.push(...r.value);
      });
    }

    // 3) 중복 제거
    const naverTitles = naverItems.map(i => normalizeTitle(i.title));
    const dedupedSiteItems = siteItems.filter(siteItem => {
      const siteTitle = normalizeTitle(siteItem.title);
      return !naverTitles.some(naverTitle => similarity(naverTitle, siteTitle) >= 0.75);
    });

    // 4) 합치기
    const allItems = [...naverItems, ...dedupedSiteItems];
    return res.status(200).json({ items: allItems, total: allItems.length, siteStatuses });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// ─── RSS 자동 감지 ────────────────────────────────────────────
// ─── 손해보험협회 정회원사 명단 조회 ──────────────────────────
async function fetchKniaSonbo() {
  const url = 'https://www.knia.or.kr/m/about/partner/partner01';
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`손해보험협회 페이지 접근 실패 (${r.status})`);
  const html = await r.text();

  // 전략 1: 페이지 내 이동용 <select><option> 목록 (정회원사 이름이 옵션값으로 나열됨)
  const selectMatch = html.match(/<select[^>]*>[\s\S]{0,8000}?메리츠화재해상보험주식회사[\s\S]{0,8000}?<\/select>/);
  if (selectMatch) {
    const names = [...selectMatch[0].matchAll(/<option[^>]*>([^<]+)<\/option>/g)]
      .map(m => m[1].trim())
      .filter(n => n && (n.includes('보험') || n.includes('재보험')));
    if (names.length >= 10) return names;
  }

  // 전략 2: 정회원사 ~ 준회원사 사이 블록의 <strong> 태그
  const sectionMatch = html.match(/정회원사([\s\S]*?)준회원사/);
  if (sectionMatch) {
    const names = [...sectionMatch[1].matchAll(/<strong>([^<]+)<\/strong>/g)].map(m => m[1].trim());
    if (names.length >= 10) return names;
  }

  throw new Error('손해보험협회 명단을 파싱하지 못했습니다 (사이트 구조 변경 의심)');
}

// ─── 생명보험협회 정회원사 명단 조회 ──────────────────────────
async function fetchKliaSaengbo() {
  const url = 'https://www.klia.or.kr/klia/company/member/list.do';
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`생명보험협회 페이지 접근 실패 (${r.status})`);
  const html = await r.text();

  const sectionMatch = html.match(/정회원([\s\S]*?)준회원/);
  const scope = sectionMatch ? sectionMatch[1] : html;

  // 전략 1: 회사명이 담긴 <h5> 태그
  let names = [...scope.matchAll(/<h5[^>]*>([^<]+)<\/h5>/g)].map(m => m[1].trim());
  if (names.length >= 10) return names;

  // 전략 2: 로고 이미지의 alt 속성
  names = [...scope.matchAll(/<img[^>]+alt="([^"]+)"/g)]
    .map(m => m[1].trim())
    .filter(n => n && n.length < 20 && !n.includes('로고') && !n.includes('아이콘'));
  if (names.length >= 10) return names;

  throw new Error('생명보험협회 명단을 파싱하지 못했습니다 (사이트 구조 변경 의심)');
}

// ─── 나무위키 대체 조회 (공식 협회 사이트 접근 실패 시 2차 시도, 비공식 출처) ───
async function fetchNamuwikiBoth() {
  const url = 'https://namu.wiki/w/%EB%B3%B4%ED%97%98%ED%9A%8C%EC%82%AC'; // 보험회사
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`나무위키 접근 실패 (${r.status})`);
  const html = await r.text();

  const sonboSection = extractSection(html, '손해보험협회', ['생명보험협회', '관련 문서', '분류']);
  const saengboSection = extractSection(html, '생명보험협회', ['손해보험협회', '관련 문서', '분류']);

  const sonbo = extractTableCompanyNames(sonboSection);
  const saengbo = extractTableCompanyNames(saengboSection);

  if (sonbo.length < 5 && saengbo.length < 5) {
    throw new Error('나무위키 명단도 파싱하지 못했습니다 (문서 구조 변경 의심)');
  }
  return { sonbo, saengbo };
}

function extractSection(html, startMarker, endMarkers) {
  const startIdx = html.indexOf(startMarker);
  if (startIdx === -1) return '';
  let endIdx = html.length;
  endMarkers.forEach(marker => {
    const idx = html.indexOf(marker, startIdx + startMarker.length);
    if (idx !== -1 && idx < endIdx) endIdx = idx;
  });
  return html.slice(startIdx, endIdx);
}

function extractTableCompanyNames(sectionHtml) {
  if (!sectionHtml) return [];
  const cells = [...sectionHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)]
    .map(m => m[1].replace(/<[^>]+>/g, '').trim())
    .filter(t => t && t.length >= 2 && t.length <= 20 && /[가-힣A-Za-z]/.test(t) && !/^[0-9.\s]+$/.test(t));
  return [...new Set(cells)];
}

async function detectRss(siteUrl) {
  if (!siteUrl) return null;
  try {
    const r = await fetch(siteUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const html = await r.text();

    const match = html.match(/<link[^>]+type=["']application\/rss\+xml["'][^>]+href=["']([^"']+)["']/i)
                || html.match(/<link[^>]+href=["']([^"']+)["'][^>]+type=["']application\/rss\+xml["']/i);
    if (match) {
      return match[1].startsWith('http') ? match[1] : new URL(match[1], siteUrl).href;
    }

    const base = siteUrl.replace(/\/$/, '');
    const candidates = [
      `${base}/rss/allArticle.xml`, `${base}/rss`, `${base}/feed`,
      `${base}/rss.xml`, `${base}/feed.xml`, `${base}/atom.xml`,
    ];
    for (const url of candidates) {
      try {
        const probe = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const ct = probe.headers.get('content-type') || '';
        if (probe.ok && (ct.includes('xml') || ct.includes('rss'))) return url;
      } catch {}
    }
    return null;
  } catch { return null; }
}

// ─── RSS 검색 ────────────────────────────────────────────────
async function searchRss({ rssUrl, query, siteName, siteDomain }) {
  try {
    const r = await fetch(rssUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return [];
    const xml = await r.text();
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
    let m;
    while ((m = itemRegex.exec(xml)) !== null) {
      const block = m[1];
      const title   = stripXml(block.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
      const link    = stripXml(block.match(/<link[^>]*>([\s\S]*?)<\/link>/i)?.[1]
                    || block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i)?.[1] || '');
      const pubDate = stripXml(block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i)?.[1] || '');
      const desc    = stripXml(block.match(/<description[^>]*>([\s\S]*?)<\/description>/i)?.[1] || '');
      if (!title || !link) continue;
      const keywords = query.split(/\s+/).filter(Boolean);
      const fullText = (title + ' ' + desc).toLowerCase();
      if (!keywords.every(kw => fullText.includes(kw.toLowerCase()))) continue;
      items.push({ title, link, originallink: link, description: desc,
        pubDate: pubDate || new Date().toUTCString(), _source: siteName, _press: siteName, _siteDomain: siteDomain });
    }
    return items;
  } catch { return []; }
}

// ─── 크롤링 검색 ─────────────────────────────────────────────
async function searchCrawl({ siteUrl, query, siteName, siteDomain }) {
  try {
    const r = await fetch(siteUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}`, items: [] };

    const html = await r.text();

    // 기사 링크 추출: <a href> 중 제목처럼 보이는 것
    const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    const items = [];
    const seen = new Set();
    let m;

    while ((m = linkRegex.exec(html)) !== null) {
      let href = m[1];
      const innerText = m[2].replace(/<[^>]+>/g, '').trim();
      if (!innerText || innerText.length < 10 || innerText.length > 200) continue;
      if (!href.startsWith('http')) {
        try { href = new URL(href, siteUrl).href; } catch { continue; }
      }
      if (!href.includes(siteDomain)) continue;
      if (seen.has(href)) continue;
      seen.add(href);

      // 키워드 필터
      const keywords = query.split(/\s+/).filter(Boolean);
      if (!keywords.every(kw => innerText.toLowerCase().includes(kw.toLowerCase()))) continue;

      items.push({ title: innerText, link: href, originallink: href, description: '',
        pubDate: new Date().toUTCString(), _source: siteName, _press: siteName, _siteDomain: siteDomain });
    }

    // 기사 링크가 전혀 없으면 구조 변경 의심
    if (seen.size === 0) return { ok: false, error: '기사 링크를 찾을 수 없음 (사이트 구조 변경 의심)', items: [] };

    return { ok: true, items };
  } catch(e) {
    return { ok: false, error: e.message, items: [] };
  }
}

// ─── 네이버 뉴스 검색 (개발자센터 방식) ────────────────────────
async function searchNaver({ query, display, start, sort, clientId, clientSecret }) {
  const p = new URLSearchParams({ query, display, start, sort });
  const r = await fetch(`https://openapi.naver.com/v1/search/news.json?${p}`, {
    headers: { 'X-Naver-Client-Id': clientId, 'X-Naver-Client-Secret': clientSecret }
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.errorMessage || err.message || `네이버 뉴스 API 오류 ${r.status}`);
  }
  const data = await r.json();
  return (data.items || []).map(item => {
    const press = extractPress(item.originallink || item.link || '');
    return { ...item, _source: 'naver', _press: press };
  });
}

// ─── 네이버 웹문서 검색 (개발자센터 방식) ──────────────────────
async function searchNaverWeb({ query, display, clientId, clientSecret, siteName, siteDomain }) {
  const p = new URLSearchParams({ query, display, start: 1 });
  const r = await fetch(`https://openapi.naver.com/v1/search/webkr.json?${p}`, {
    headers: { 'X-Naver-Client-Id': clientId, 'X-Naver-Client-Secret': clientSecret }
  });
  if (!r.ok) return [];
  const data = await r.json();
  return (data.items || [])
    .filter(item => (item.link || '').includes(siteDomain))
    .map(item => ({ title: item.title || '', link: item.link || '', originallink: item.link || '',
      description: item.description || '', pubDate: item.pubDate || new Date().toUTCString(),
      _source: siteName, _press: siteName, _siteDomain: siteDomain }));
}

function stripXml(str) {
  return (str || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').trim();
}

function extractPress(url) {
  try {
    const domain = url.replace(/https?:\/\//, '').split('/')[0].replace(/^www\./, '');
    const map = {
      'inews24.com': '아이뉴스24', 'greened.kr': '그린경제', 'hankyung.com': '한국경제',
      'chosun.com': '조선일보', 'joongang.co.kr': '중앙일보', 'donga.com': '동아일보',
      'hani.co.kr': '한겨레', 'mk.co.kr': '매일경제', 'sedaily.com': '서울경제',
      'etnews.com': '전자신문', 'yonhapnews.co.kr': '연합뉴스', 'yna.co.kr': '연합뉴스',
      'newsis.com': '뉴시스', 'news1.kr': '뉴스1', 'mt.co.kr': '머니투데이',
      'bizwatch.co.kr': '비즈워치', 'the-bell.co.kr': '더벨',
      'insurancejournal.co.kr': '보험저널', 'insjournal.co.kr': '보험저널',
      'newsport.co.kr': '뉴스포트', 'fntimes.com': '한국금융신문', 'insura.net': '보험일보', 'kfnews.co.kr': '한국금융', 'fins.co.kr': '보험매일', 'kbanker.co.kr': '대한금융신문', 'insjournal.co.kr': '보험저널', 'instoday.co.kr': '보험일보', 'insnews.co.kr': '한국보험신문', 'insweek.co.kr': '보험신보',
    };
    return map[domain] || domain;
  } catch { return ''; }
}

function normalizeTitle(title) {
  return title.replace(/<[^>]*>/g, '').replace(/[^\w\uAC00-\uD7A3]/g, '').toLowerCase().trim();
}

function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const shorter = a.length < b.length ? a : b;
  const longer  = a.length < b.length ? b : a;
  let matches = 0;
  for (let i = 0; i < shorter.length; i++) {
    if (longer.includes(shorter[i])) matches++;
  }
  return matches / longer.length;
}
