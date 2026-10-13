// Deployment settings. The Docker image rewrites this file at start-up from environment variables.
window.SC_CONFIG = {
  pdfjsBase: '',        // '' = load PDF.js from the jsDelivr CDN; './vendor/' = self-hosted copy
  aiEnabled: true,      // false hides AI triage, so no text ever leaves the browser
  environmentLabel: '', // optional subtitle, e.g. 'Internal – client data stays in your browser'
};
