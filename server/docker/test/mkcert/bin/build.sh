#!/bin/sh

export CAROOT="$PWD"

if ! command -v mkcert; then
  echo "mkcert is not available"
  exit 1
fi

if [ ! -f rootCA.pem ]; then
  echo "Making root CA"
  mkcert
fi

for _domain in \
  initech.com \
  open.relay \
  qmail.com \
  yahoo.com \
  virtu.email
do
  if [ ! -f "$_domain-key.pem" ]; then
    mkcert -cert-file "$_domain.pem" -key-file "$_domain-key.pem" "$_domain" "*.$_domain"
  fi
done

