# SourceCheck: self-hosted image for Dokploy.
# Static site served by nginx. PDF.js is bundled into the image, Google Fonts are stripped,
# and a strict Content-Security-Policy blocks every third-party request, so client documents
# never leave the user's browser (unless AI triage is explicitly enabled).

FROM node:20-alpine AS vendor
WORKDIR /tmp/pdfjs
RUN npm pack pdfjs-dist@4.10.38 --silent && tar xzf pdfjs-dist-4.10.38.tgz

FROM nginx:1.27-alpine
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/40-sourcecheck-config.sh /docker-entrypoint.d/40-sourcecheck-config.sh
COPY index.html style.css main.js core.js ai.js config.js /usr/share/nginx/html/
COPY demo /usr/share/nginx/html/demo
COPY --from=vendor /tmp/pdfjs/package/legacy/build/pdf.min.mjs /tmp/pdfjs/package/legacy/build/pdf.worker.min.mjs /usr/share/nginx/html/vendor/
RUN sed -i '/fonts.googleapis.com/d;/fonts.gstatic.com/d' /usr/share/nginx/html/index.html \
 && chmod +x /docker-entrypoint.d/40-sourcecheck-config.sh

# AI_ENABLED=true lets users call the Anthropic API from their browser with their own key.
# Keep it false unless InfoSec has approved sending client text to Anthropic.
ENV AI_ENABLED=false \
    ENVIRONMENT_LABEL="Internal · client files stay in your browser"

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1/healthz || exit 1
