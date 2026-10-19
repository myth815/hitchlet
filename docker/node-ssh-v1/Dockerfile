FROM node:24-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-server ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && rm -f /etc/ssh/ssh_host_* \
 && useradd --create-home --home-dir /workspace --shell /bin/bash workspace \
 && mkdir -p /run/sshd /run/hitchlet /workspace \
 && chown workspace:workspace /workspace \
 && chmod 0755 /workspace

COPY entrypoint.sh /usr/local/bin/hitchlet-entrypoint
RUN chmod 0755 /usr/local/bin/hitchlet-entrypoint

EXPOSE 22
ENTRYPOINT ["/usr/local/bin/hitchlet-entrypoint"]
