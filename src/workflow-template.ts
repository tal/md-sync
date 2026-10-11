// The GitHub Action that posts each pushed sha to ntfy (README "Remote push events"). Pure.

export const WORKFLOW_NAME = 'mdsync-notify';
export const WORKFLOW_PATH = `.github/workflows/${WORKFLOW_NAME}.yml`;
export const NTFY_SECRET = 'MDSYNC_NTFY_URL';

// YAML 1.1 words that a plain scalar would turn into a bool or null.
const YAML_KEYWORDS = new Set(['y', 'n', 'yes', 'no', 'true', 'false', 'on', 'off', 'null']);

// GitHub's branch filters are globs: escape the filter metacharacters git allows in a ref name so the
// pattern matches the branch literally. Then emit a plain scalar only when the doc's character class
// allows it AND YAML would read it back as that exact string (letter first: no numbers, dates or .inf);
// anything else is JSON-quoted, which is valid YAML double-quoted syntax.
function branchScalar(branch: string): string {
  const pattern = branch.replace(/[*?+[\]!]/g, '\\$&');
  const plain = /^[A-Za-z0-9._\/-]+$/.test(pattern) && /^[A-Za-z]/.test(pattern)
    && !YAML_KEYWORDS.has(pattern.toLowerCase());
  return plain ? pattern : JSON.stringify(pattern);
}

// ntfy's reply echoes the topic, which is the secret: -o /dev/null keeps it out of the Actions log.
export function renderWorkflow(branch: string): string {
  return `# ${WORKFLOW_PATH}
name: ${WORKFLOW_NAME}
on:
  push:
    branches: [${branchScalar(branch)}]
jobs:
  notify:
    runs-on: ubuntu-latest
    steps:
      - run: curl -fsS -o /dev/null -d "$GITHUB_SHA" "$NTFY_URL"
        env:
          NTFY_URL: \${{ secrets.${NTFY_SECRET} }}
`;
}
