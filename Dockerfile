# Static site: no build step. Unprivileged nginx listens on 8080 (set the kapps app port to 8080).
FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY --chown=nginx:nginx index.html style.css app.js planner.js presets.js /usr/share/nginx/html/
COPY --chown=nginx:nginx providers/ /usr/share/nginx/html/providers/
EXPOSE 8080
