# Fake-internet BIND for the test network (Lane H).
#
# Authoritative for every domain the simulated internet knows about
# (see rootfs/templates/zones/). Hermetic: no forwarders — nothing the tests
# do can ever resolve (or mail) a real host.
#
# Ported from tmp/virtu/server/docker/test/dns (proven).
FROM alpine:3.18

EXPOSE 53

RUN apk --no-cache add bind \
  && mkdir -p /var/cache/bind \
  && mkdir -p /var/lib/bind \
  && chown -R named:named /var/cache/bind /var/lib/bind

COPY ./rootfs/ /

CMD ["/entrypoint.sh"]
