export default async function handler(req, res) {
  const { query, sites, start } = req.query;
  const startTime = start ? parseInt(start, 10) : null;

  if (!sites) {
    return res.status(400).json({ error: '조회할 사이트 목록이 없습니다.' });
  }

  let siteList;
  try {
    siteList = JSON.parse(sites);
  } catch (e) {
    return res.status(400).json({ error: 'sites 파라미터가 올바르지 않습니다.' });
  }

  const siteStatuses = [];
  const updatedRss = [];
  let allItems = [];

  const tasks = siteList.map(async site => {
    try {
      let rssUrl = site.rssUrl;

      // 캐시된 RSS 주소가 있으면 우선 시도
      if (rssUrl) {
        const items = await searchRss({ rssUrl, query, siteName: site.name });
        if (items !== null) {
          siteStatuses.push({ name: site.name, type: 'rss', ok: true });
          return items;
        }
        rssUrl = null; // 캐시된 주소가 실패하면 재감지 시도
      }

      // RSS 자동 감지 (사이트 개편에 대비 — <link rel="alternate" type="application/rss+xml"> 탐지)
      rssUrl = await detectRss(site.url);
      if (rssUrl) {
        const items = await searchRss({ rssUrl, query, siteName: site.name });
        if (items !== null) {
          updatedRss.push({ url: site.url, rssUrl });
          siteStatuses.push({ name: site.name, type: 'rss', ok: true });
          return items;
        }
      }

      // RSS 실패 시 크롤링 폴백 (페이지 자동 순회)
      const result = await searchFssCrawl({ siteUrl: site.url, query, siteName: site.name, startTime });
      siteStatuses.push({ name: site.name, type: 'crawl', ok: result.ok, error: result.error, truncated: result.truncated });
      return result.items;
    } catch (e) {
      siteStatuses.push({ name: site.name, type: 'crawl', ok: false, error: e.message });
      return [];
    }
  });

  const results = await Promise.allSettled(tasks);
  results.forEach(r => { if (r.status === 'fulfilled') allItems.push(...r.value); });

  // 중복 제거 (동일 링크)
  const seen = new Set();
  allItems = allItems.filter(item => {
    if (seen.has(item.link)) return false;
    seen.add(item.link);
    return true;
  });

  return res.status(200).json({ items: allItems, total: allItems.length, siteStatuses, updatedRss });
}

// ─── RSS 자동 감지 (뉴스 사이트용 detectRss와 동일한 범용 로직) ───
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
    return null;
  } catch { return null; }
}

// ─── RSS 파싱 (실패 시 null 반환 → 크롤링 폴백으로 전환) ───
async function searchRss({ rssUrl, query, siteName }) {
  try {
    const r = await fetch(rssUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return null;
    const xml = await r.text();
    if (!xml.includes('<item') && !xml.includes('<entry')) return null;

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
      if (query) {
        const keywords = query.split(/\s+/).filter(Boolean);
        const fullText = (title + ' ' + desc).toLowerCase();
        if (!keywords.every(kw => fullText.includes(kw.toLowerCase()))) continue;
      }
      items.push({ title, link, pubDate: pubDate || new Date().toUTCString(), _source: siteName });
    }
    return items;
  } catch { return null; }
}

// ─── 크롤링 폴백: 한국 정부기관 게시판(list.do/view.do) 공통 패턴, 페이지 자동 순회 ───
async function searchFssCrawl({ siteUrl, query, siteName, startTime }) {
  const MAX_PAGES = startTime ? 10 : 5; // 기간 지정 시 10페이지, "전체"는 5페이지로 제한 (실행시간 안전장치)
  const items = [];
  const seen = new Set();
  let prevFirstLink = null;
  let truncated = false;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const pageUrl = page === 1 ? siteUrl : appendPageParam(siteUrl, page);
    let html;
    try {
      const r = await fetch(pageUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) {
        if (page === 1) return { ok: false, error: `HTTP ${r.status}`, items: [] };
        break; // 이후 페이지 접근 실패 시 지금까지 모은 것만 반환
      }
      html = await r.text();
    } catch (e) {
      if (page === 1) return { ok: false, error: e.message, items: [] };
      break;
    }

    const pageItems = parseFssRows(html, siteUrl, query);

    if (pageItems.length === 0) break; // 더 이상 게시글 없음 → 마지막 페이지

    // 페이지네이션 파라미터가 실제로 안 먹혀서 같은 페이지가 반복되는 경우 감지
    if (prevFirstLink && pageItems[0].link === prevFirstLink) break;
    prevFirstLink = pageItems[0].link;

    let hitBoundary = false;
    for (const it of pageItems) {
      if (seen.has(it.link)) continue;
      seen.add(it.link);
      it._source = siteName;
      items.push(it);
      if (startTime && new Date(it.pubDate).getTime() < startTime) {
        hitBoundary = true; // 이 항목보다 오래된 건 필요 없음 (최신순 정렬 전제)
      }
    }

    if (hitBoundary) break; // 요청한 기간보다 오래된 글에 도달 → 순회 중단
    if (page === MAX_PAGES) truncated = true; // 페이지 한도 도달 (더 있을 수 있음)
  }

  if (seen.size === 0) return { ok: false, error: '게시글 목록을 찾을 수 없음 (사이트 구조 변경 의심)', items: [] };
  return { ok: true, items, truncated };
}

function appendPageParam(url, page) {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}pageIndex=${page}`;
}

function parseFssRows(html, siteUrl, query) {
  const items = [];
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = rowRegex.exec(html)) !== null) {
    const row = m[1];
    const linkMatch = row.match(/<a[^>]+href="([^"]*view\.do[^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;
    let href = linkMatch[1].replace(/&amp;/g, '&');
    if (!href.startsWith('http')) {
      try { href = new URL(href, siteUrl).href; } catch { continue; }
    }

    const title = linkMatch[2].replace(/<[^>]+>/g, '').trim();
    if (!title || title.length < 3) continue;

    if (query) {
      const keywords = query.split(/\s+/).filter(Boolean);
      if (!keywords.every(kw => title.toLowerCase().includes(kw.toLowerCase()))) continue;
    }

    const dateMatch = row.match(/(\d{4})[.\-](\d{2})[.\-](\d{2})/);
    const pubDate = dateMatch ? new Date(`${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`).toUTCString() : new Date().toUTCString();

    items.push({ title, link: href, pubDate, _source: null });
  }
  return items;
}

function stripXml(str) {
  return (str || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').trim();
}
