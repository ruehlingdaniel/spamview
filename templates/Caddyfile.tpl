# SpamView reverse proxy with auto-TLS (internal CA) + LAN allowlist + basic auth
{
	admin off
}

https://%%LISTEN%% {
	tls internal

	@lan remote_ip 192.168.0.0/16 10.0.0.0/8 172.16.0.0/12 127.0.0.0/8

	handle @lan {
		basic_auth {
			%%AUTH_USER%% %%AUTH_HASH%%
		}
		reverse_proxy 127.0.0.1:3050
	}

	handle {
		respond "Forbidden — LAN only" 403
	}

	encode gzip zstd

	log {
		output file /var/log/caddy/spamview.log {
			roll_size 10mb
			roll_keep 5
		}
		format console
	}
}

http://%%LISTEN_PLAIN%% {
	redir https://%%LISTEN_PLAIN%%{uri} permanent
}
