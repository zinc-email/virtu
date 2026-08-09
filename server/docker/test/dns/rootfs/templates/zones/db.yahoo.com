; Strictest anti-spam policy among the "major providers" of the fake net.
$ORIGIN yahoo.com.
$TTL 60
;                 email    serial      refresh  retry  exp   ttl
@    IN SOA  ns ( root     2026080801  1800     600    3600  900 )
@    IN NS   ns
@    IN MX   10 mail
@    IN A    192.168.34.10
mx1  IN A    192.168.34.10
ns   IN A    192.168.34.254
mail IN A    192.168.34.10
@    IN TXT  "v=spf1 +a -all"
mail IN TXT  "v=spf1 +a -all"
_dmarc IN TXT "v=DMARC1; p=reject; pct=100; rua=mailto:postmaster@yahoo.com;"
