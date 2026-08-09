; A customer's (Wes's) personal domain, hosted on virtu: MX at our mx, SPF
; delegated to spf1.virtu.email, VERP bounce host zbounces CNAME'd at us.
; DKIM records arrive at runtime via nsupdate (allow-update in named.conf).
$ORIGIN user.com.
$TTL 60
;                       email    serial      refresh  retry  exp   ttl
@         IN SOA   ns ( root     2026080801  1800     600    3600  900 )
          IN NS    ns
          IN MX    10 mail.virtu.email.
          IN TXT   "v=spf1 include:spf1.virtu.email ~all"
          IN A     192.168.34.8
ns        IN A     192.168.34.254
mail      IN A     192.168.34.8
zbounces  IN CNAME mail.virtu.email.
www       IN CNAME user.com.
