; Legit outside correspondent (Milton works here). Fully armed: SPF, DKIM
; (shared test key, selector "default"), and DMARC p=reject.
$ORIGIN initech.com.
$TTL 60
;                 email    serial      refresh  retry  exp   ttl
@    IN SOA  ns ( root     2026080801  1800     600    3600  900 )
@    IN NS   ns
@    IN MX   10 mail
@    IN A    192.168.34.12
mx1  IN A    192.168.34.12
ns   IN A    192.168.34.254
mail IN A    192.168.34.12
@    IN TXT  "v=spf1 +a -all"
mail IN TXT  "v=spf1 +a -all"
_dmarc IN TXT "v=DMARC1; p=reject; sp=reject; pct=100; rua=mailto:milton@initech.com;"
; Public half of the shared peer signing key
; (server/docker/test/smtpd/rootfs/var/db/dkim/default.private).
default._domainkey	IN	TXT	( "v=DKIM1; k=rsa; "
	  "p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDV6tiKh4CPQqAIYlx3udAjrAX5DOfvExo75Frizzaya/DZTrlLPLgn2kTTaj46dyQwsbymAH7DVjuxRPkEgIVxJ8y8RqI93woPenKm9v0HSPmuXIrCtyjR3Jfj7i1R0B7LDwJa0VgJwrxsTKTl9DkRQxbszJoVk3HTOZRYYYTKLwIDAQAB" )
