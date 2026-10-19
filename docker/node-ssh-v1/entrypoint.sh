#!/bin/sh
set -eu

if [ ! -s /run/hitchlet/authorized_keys ]; then
  echo 'missing Hitchlet SSH bootstrap key' >&2
  exit 70
fi

install -d -m 0700 -o workspace -g workspace /workspace/.ssh
install -m 0600 -o workspace -g workspace /run/hitchlet/authorized_keys /workspace/.ssh/authorized_keys
rm -f /run/hitchlet/authorized_keys
ssh-keygen -A
cat > /etc/ssh/sshd_config.d/99-hitchlet.conf <<'EOF'
Port 22
AddressFamily inet
ListenAddress 0.0.0.0
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AuthenticationMethods publickey
AllowUsers workspace
AllowTcpForwarding no
AllowAgentForwarding no
X11Forwarding no
PermitTunnel no
PermitUserEnvironment no
EOF
chown root:root /etc/ssh/sshd_config.d/99-hitchlet.conf
chmod 0600 /etc/ssh/sshd_config.d/99-hitchlet.conf
chown workspace:workspace /workspace
/usr/sbin/sshd -t
exec /usr/sbin/sshd -D -e
