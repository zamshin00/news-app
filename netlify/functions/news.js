exports.handler = async function(event) {
  const params = event.queryStringParameters || {};
  const { query, display, start, sort, clientId, clientSecret, type, sites } = params;

  if (!query || !clientId || !clientSecret) {
    return {
      statusCode: 400,
      headers: corsHeaders(),
      body: JSON.stringify({ error: '필수 파라미터가 없습니다.' })
    };
  }

  // 웹문서 검색 (신문사 홈페이지 찾기용)
  if (type === 'webkr') {
    try {
      const p = new URLSearchParams({ query, display: display || 10, start: start || 1 });
      const res = await fetch(`https://openapi.naver.com/v1/search/webkr.json?${p}`, {
        headers: { 'X-Naver-Client-Id': clientId, 'X-Naver-Client-Secret': clientSecret }
      });
      const data = await res.json();
      return { statusCode: 200, headers: corsHeaders(), body: JSON.stringify(data) };
    } catch(e) {
      return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: e.message }) };
    }
  }

  try {
    // 1) 네이버 뉴스 API 검색 (항상 실행)
    const naverItems = await searchNaver({ query, display: display || 100, start: start || 1, sort: sort || 'date', clientId, clientSecret });

    // 2) 개별 사이트 검색 (sites 파라미터가 있을 때만)
    let siteItems = [];
    if (sites) {
      const siteList = JSON.parse(sites); // [{name, url, domain}] 배열
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

    // 3) 중복 제거: 네이버 뉴스 기사 제목과 80% 이상 유사한 사이트 기사 제거
    const naverTitles = naverItems.map(i => normalizeTitle(i.title));
    const dedupedSiteItems = siteItems.filter(siteItem => {
      const siteTitle = normalizeTitle(siteItem.title);
      return !naverTitles.some(naverTitle => similarity(naverTitle, siteTitle) >= 0.75);
    });

    // 4) 합치기 (네이버 뉴스 우선, 사이트 기사 추가)
    const allItems = [...naverItems, ...dedupedSiteItems];

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({ items: allItems, total: allItems.length })
    };

  } catch (e) {
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({ error: e.message })
    };
  }
};

// ─── 네이버 뉴스 검색 ───────────────────────────────────────────
async function searchNaver({ query, display, start, sort, clientId, clientSecret }) {
  const p = new URLSearchParams({ query, display, start, sort });
  const res = await fetch(`https://openapi.naver.com/v1/search/news.json?${p}`, {
    headers: {
      'X-Naver-Client-Id': clientId,
      'X-Naver-Client-Secret': clientSecret
    }
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.errorMessage || `네이버 뉴스 API 오류 ${res.status}`);
  }
  const data = await res.json();
  return (data.items || []).map(item => ({
    ...item,
    _source: 'naver'
  }));
}

// ─── 네이버 웹문서 검색으로 개별 사이트 검색 ─────────────────────
async function searchNaverWeb({ query, display, clientId, clientSecret, siteName, siteDomain }) {
  const p = new URLSearchParams({ query, display, start: 1 });
  const res = await fetch(`https://openapi.naver.com/v1/search/webkr.json?${p}`, {
    headers: {
      'X-Naver-Client-Id': clientId,
      'X-Naver-Client-Secret': clientSecret
    }
  });
  if (!res.ok) return []; // 사이트별 에러는 무시하고 계속

  const data = await res.json();
  return (data.items || [])
    .filter(item => {
      // 해당 도메인 기사만 필터
      const link = item.link || '';
      return link.includes(siteDomain);
    })
    .map(item => ({
      title: item.title || '',
      link: item.link || '',
      originallink: item.link || '',
      description: item.description || '',
      pubDate: item.pubDate || new Date().toUTCString(), // 웹검색은 날짜가 없는 경우 있음
      _source: siteName,
      _siteDomain: siteDomain
    }));
}

// ─── 유틸 ───────────────────────────────────────────────────────
function corsHeaders() {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  };
}

function normalizeTitle(title) {
  return title
    .replace(/<[^>]*>/g, '')           // HTML 태그 제거
    .replace(/[^\w\uAC00-\uD7A3]/g, '') // 특수문자 제거 (한글+영숫자만)
    .toLowerCase()
    .trim();
}

// 두 문자열의 유사도 (0~1): 공통 글자 수 / 최대 길이
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
