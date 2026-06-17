exports.handler = async function(event) {
  const { query, display, start, sort, clientId, clientSecret } = event.queryStringParameters || {};
  if (!query || !clientId || !clientSecret) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: '필수 파라미터가 없습니다.' })
    };
  }
  const params = new URLSearchParams({ query, display: display || 10, start: start || 1, sort: sort || 'date' });
  try {
    const response = await fetch(`https://openapi.naver.com/v1/search/news.json?${params}`, {
      headers: {
        'X-Naver-Client-Id': clientId,
        'X-Naver-Client-Secret': clientSecret
      }
    });
    const data = await response.json();
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify(data)
    };
  } catch (e) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: e.message })
    };
  }
};
