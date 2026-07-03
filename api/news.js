export default async function handler(req, res) {
  const { query, display, start, sort, clientId, clientSecret, type, sites, naverEnabled } = req.query;

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
    // 1) 네이버 뉴스 API 검색 (naverEnabled가 '0'이면 스킵)
    const naverItems = naverEnabled === '0' ? [] : await searchNaver({ query, display: display || 100, start: start || 1, sort: sort || 'date', clientId, clientSecret });

    // 2) 개별 사이트 검색
    let siteItems = [];
    if (sites) {
      const siteList = JSON.parse(sites);
      const siteSearches = siteList.map(site =>
        searchNaverWeb({
          query: `${query} site:${site.domain}`,
          display: 20,
          clientId,
          clientSecret,
          siteName: site.name,
          siteDomain: site.domain
        })
      );
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
    return res.status(200).json({ items: allItems, total: allItems.length });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

async function searchNaver({ query, display, start, sort, clientId, clientSecret }) {
  const p = new URLSearchParams({ query, display, start, sort });
  const r = await fetch(`https://openapi.naver.com/v1/search/news.json?${p}`, {
    headers: { 'X-Naver-Client-Id': clientId, 'X-Naver-Client-Secret': clientSecret }
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.errorMessage || `네이버 뉴스 API 오류 ${r.status}`);
  }
  const data = await r.json();
  return (data.items || []).map(item => {
    // originallink 도메인에서 신문사 추출
    const press = extractPress(item.originallink || item.link || '');
    return { ...item, _source: 'naver', _press: press };
  });
}

async function searchNaverWeb({ query, display, clientId, clientSecret, siteName, siteDomain }) {
  const p = new URLSearchParams({ query, display, start: 1 });
  const r = await fetch(`https://openapi.naver.com/v1/search/webkr.json?${p}`, {
    headers: { 'X-Naver-Client-Id': clientId, 'X-Naver-Client-Secret': clientSecret }
  });
  if (!r.ok) return [];
  const data = await r.json();
  return (data.items || [])
    .filter(item => (item.link || '').includes(siteDomain))
    .map(item => ({
      title: item.title || '',
      link: item.link || '',
      originallink: item.link || '',
      description: item.description || '',
      pubDate: item.pubDate || new Date().toUTCString(),
      _source: siteName,
      _siteDomain: siteDomain
    }));
}

function extractPress(url) {
  try {
    const domain = url.replace(/https?:\/\//, '').split('/')[0].replace(/^www\./, '');
    // 주요 언론사 도메인 매핑
    const map = {
      'inews24.com': '아이뉴스24',
      'greened.kr': '그린경제',
      'hankyung.com': '한국경제',
      'chosun.com': '조선일보',
      'joongang.co.kr': '중앙일보',
      'donga.com': '동아일보',
      'hani.co.kr': '한겨레',
      'mk.co.kr': '매일경제',
      'sedaily.com': '서울경제',
      'etnews.com': '전자신문',
      'yonhapnews.co.kr': '연합뉴스',
      'yna.co.kr': '연합뉴스',
      'newsis.com': '뉴시스',
      'news1.kr': '뉴스1',
      'mt.co.kr': '머니투데이',
      'bizwatch.co.kr': '비즈워치',
      'the-bell.co.kr': '더벨',
      'insurancejournal.co.kr': '보험저널',
      'insjournal.co.kr': '보험저널',
      'newsport.co.kr': '뉴스포트',
      'fntimes.com': '한국금융신문',
      'kfnews.co.kr': '한국금융',
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
