# Parameterized fake-peer MTA for the simulated internet (Lane H).
#
# One image, instantiated once per pretend domain (qmail.com, initech.com, …)
# via the MAIL_DOMAIN env var. Runs postfix + opendkim + opendmarc +
# policyd-spf under runit, signs outbound mail for its own domain with the
# shared test DKIM key, verifies inbound mail from other peers, and delivers
# local mail one-file-per-message into Maildirs under /var/mail (shared
# volume) — see templates/postfix/vmailbox.
#
# Ported from tmp/virtu/server/docker/test/smtpd (proven). Changes:
#   - build context is server/docker/test/ so the mkcert CA + per-domain TLS
#     certs bake into the image (legacy mounted them at runtime)
#   - Maildir delivery into /var/mail instead of mbox in /tmp/mail
#
# Build (from repo root):
#   docker build -f server/docker/test/smtpd/Dockerfile server/docker/test
FROM alpine:3.18

# The Docker default signal is TERM. However, from runsvdir manual:
#
# > If runsvdir receives a TERM signal, it exits with 0 immediately.
# >
# > If runsvdir receives a HUP signal, it sends a TERM signal to each
# > runsv(8) process it is monitoring and then exits with 111.
#
STOPSIGNAL SIGHUP

ENV MAIL_DOMAIN=example.com
ENV POSTFIX_INET_INTERFACES=all

# -------

# BEGIN app/user
# see https://git.alpinelinux.org/aports/tree/main/postfix/postfix.pre-install
# This UID/GID should be shared across containers so they all have access to
# the shared Maildir spool volume.

ARG GROUP_ID=1000
ARG USER_ID=1000

RUN addgroup -S -g ${GROUP_ID} postfix \
  && adduser -S -H -h /var/spool/postfix -G postfix -g postfix -u ${USER_ID} postfix

# END app/user

# -------

RUN apk add --no-cache \
  bind-tools \
  busybox-extras \
  cyrus-sasl \
  cyrus-sasl-login \
  cyrus-sasl-crammd5 \
  gettext-envsubst \
  postfix \
  postfix-pcre \
  policyd-spf-fs \
  opendkim \
  opendkim-utils \
  runit

RUN addgroup postfix opendkim \
  && install -d -o opendkim -g opendkim /run/opendkim/ \
  && apk add --no-cache opendmarc

RUN apk add --no-cache ca-certificates

# Make sv command work properly
ENV SVDIR=/service

# You can override these with volumes if you choose
COPY smtpd/rootfs /

# Test CA + per-domain TLS certs (test-only material, safe to commit).
# entrypoint.d/10-trusted-ca installs the root into the system trust store;
# entrypoint.d/30-postfix picks /etc/mkcert/$MAIL_DOMAIN.pem when it exists.
COPY mkcert /etc/mkcert

EXPOSE 25
EXPOSE 587

CMD [ "runsvdir", "/service" ]
ENTRYPOINT [ "/entrypoint.sh" ]
