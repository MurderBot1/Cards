// CORS for every /api route. The app (a WebView or desktop window serving from 127.0.0.1) calls this service
// directly. Requests authenticate with an Authorization header, never cookies, so allowing any origin does not let
// another site act as a signed-in user.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

export async function onRequest({ request, next }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  let response;
  try {
    response = await next();
  } catch (err) {
    console.error(err);
    response = new Response(JSON.stringify({ error: 'Something went wrong on the server' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  response = new Response(response.body, response);
  for (const [name, value] of Object.entries(CORS)) response.headers.set(name, value);
  return response;
}
