// CORS for the API. The app (a WebView or desktop window serving from 127.0.0.1) calls this service directly.
// Requests authenticate with an Authorization header, never cookies, so allowing any origin does not let another
// site act as a signed-in user.
export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

export function withCors(response) {
  response = new Response(response.body, response);
  for (const [name, value] of Object.entries(CORS)) response.headers.set(name, value);
  return response;
}
