/**
 * env-var: detector stub. Real implementation lands in a follow-up F3 commit.
 * Keeping the export stable so scripts/edges/index.mjs imports don't break.
 */
const NAME = 'env-var';
async function* detect(_ctx) { /* no-op for now */ return; }
export default { name: NAME, detect };
