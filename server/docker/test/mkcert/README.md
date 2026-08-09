Certificate Authority
=====================

I used [`mkcert`](https://github.com/FiloSottile/mkcert) for this job.

Note there are other tools:

- [cfssl](https://github.com/cloudflare/cfssl)
  - [see how Void Linux uses it](https://github.com/void-linux/void-infrastructure/blob/master/CA/bin/gencerts.sh)



Why
---

For local integration and end-to-end testing (without standing up real email
servers on the internet), we host a local Bind9 DNS server and SSL certificates
signed by a locally trusted & managed certificate authority (CA).

Using locally hosted SMTP servers, we can achieve an internet-like network
to test sending and receiving email.

For posterity, here is an example of the type of error you encounter when
not using a locally trusted CA.

```log
warn  phpunit 9.588  stream_socket_enable_crypto(): SSL operation failed with code 1. OpenSSL Error messages:
error:1416F086:SSL routines:tls_process_server_certificate:certificate verify failed in file /virtu/src/lib/Email/Mailer/Smtp/Client.php on line 174
```


Set-up
------

`mkcert` generates a new root CA in `~/.local/share/mkcert/rootCA[-key].pem`. To
use the existing rootCA, just copy them from this repo into that directory.

`mkcert -install` installs the CA into `/usr/local/share/ca-certificates` then
runs `sudo update-ca-certificates`. It handles some other use cases like Firefox
too, but we don't need that.

To do this manually...

```sh
cp etc/ssl/mkcert/rootCA* $HOME/.local/share/mkcert/
sudo cp etc/ssl/mkcert/rootCA.pem /usr/local/share/ca-certificates/virtu.crt
sudo update-ca-certificates
```

Create a new certificate
------------------------

```sh
mkcert *.virtu.email
```
