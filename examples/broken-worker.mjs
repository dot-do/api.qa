/**
 * A NON-conforming worker — publishes nothing an agent can discover, so
 * `api.qa dev` grades it F and EXITS NON-ZERO. This is the shape a CI gate
 * catches before it ever deploys:
 *
 *   npx autonomous-qa dev examples/broken-worker.mjs   # → grade F, exit 1
 */
export default {
  fetch() {
    return new Response(JSON.stringify({ error: 'not found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    })
  },
}
