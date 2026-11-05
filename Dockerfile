FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    FACTU_DB=/data/facturation.db FACTU_SECURE_COOKIE=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
COPY static ./static
COPY scripts ./scripts
COPY wsgi.py ./
COPY deploy/entrypoint.sh /entrypoint.sh
RUN useradd -m lab && mkdir -p /data && chown lab /data && chmod +x /entrypoint.sh
EXPOSE 8000
CMD ["/entrypoint.sh"]
