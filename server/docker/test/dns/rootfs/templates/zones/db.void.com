; Blackhole for performance/volume testing: the peer catch-alls every
; recipient into one Maildir sink (see smtpd vmailbox: @void.com).
$ORIGIN void.com.
$TTL 60
;                 email    serial      refresh  retry  exp   ttl
@    IN SOA  ns ( root     2026080801  1800     600    3600  900 )
@    IN NS   ns
@    IN MX   10 mail
@    IN A    192.168.34.11
mx1  IN A    192.168.34.11
ns   IN A    192.168.34.254
mail IN A    192.168.34.11
@    IN TXT  "v=spf1 a -all"
mail IN TXT  "v=spf1 a -all"
