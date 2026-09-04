#!/bin/sh
sed -i "s/access_log off;/access_log stdout combined;/" /etc/nginx/nginx.conf
nginx -s reload
echo "waiting for requests..."
tail -f /var/log/nginx/access.log 2>/dev/null || tail -f /config/clawd/logs/gateway_startup.log 2>/dev/null || true
