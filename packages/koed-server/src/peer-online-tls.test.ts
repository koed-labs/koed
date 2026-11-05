import { createHash } from "node:crypto";
import {
  connect as netConnect,
  createServer as createNetServer
} from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
import {
  connectPeerOnline,
  listenPeerOnline,
  PEER_ONLINE_ALPN
} from "./peer-online-tls.js";

const fixtures = {
  "ca.crt": `-----BEGIN CERTIFICATE-----
MIIC2jCCAcKgAwIBAgIUPGYRcfiHtwCKi0ODRpwIx3cIROswDQYJKoZIhvcNAQEL
BQAwDTELMAkGA1UEAwwCY2EwHhcNMjYxMTA0MjE1NzQwWhcNMzYxMTAxMjE1NzQw
WjANMQswCQYDVQQDDAJjYTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEB
AKyEJlnvVL1JfoPpsXJV4fJ98vllk/RceaF4NfnUQyNnsnViai0V2ezQJohMTSeR
HVAUePc6X44ekoPt8+yUV1AMMOu5XKcq5iqcFq3XlVOkhId9af7i4eQmWVpabYxc
qpCH0APDFYtwE3QVYV3MCjqZQR35EQVcJAczSNc7zbXp1ojKbvzgtJneTowuclZa
KKBH4p7BfgF1zFxzww/9k16rVjgrpGdTMUaEVpgFCJAHd8D85T7b169g28Aq0ESR
/eHPq8sRZTIPnZ0awqMHM4bnoP9dmI/i7Lma51pQ9GWjT0qFJbQo7pllhk1lurWg
HNxLxPifRpW81ZNVkeV1h0MCAwEAAaMyMDAwHQYDVR0OBBYEFGH67/iElCHjiBAL
9Bq9d1FMjFCLMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAI3U
HYnx1tu076c1t713s7J6SOL2zHt0xwm5TLlIaDtsEd5HxPNjJwL1c6+uf2nehGdj
Tz5GHDcHscEBaiwsp9pZKDYwopKQ1rlg8WikuUVgEviKCjOSr64F1tEYkjiwEfiX
rj63UxTfF+Xwd1uObgWoQrRH/ql9ot2usJzfznzh1s+C8dIwMU0DtQ+U0IWkcbYD
ahZRKYs2Yacn43s//OKscIwmzJIjlOEqGbFB2Lv4Dnxe0mtRCD4BkXSrFXKIPXU6
7jzRsMpnzlAXBcgo7ok09xxEnxhsfzWk2ak0F9sTuyqvc0jXod87HITugGViAufc
xH6t4YbDNvF5a0WhF8w=
-----END CERTIFICATE-----
`,
  "server.crt": `-----BEGIN CERTIFICATE-----
MIIC5jCCAc6gAwIBAgIULXWisBrp16sbCccV5zpjmkesD24wDQYJKoZIhvcNAQEL
BQAwDTELMAkGA1UEAwwCY2EwHhcNMjYxMTA0MjE1NzQwWhcNMzYxMTAxMjE1NzQw
WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAw
ggEKAoIBAQCo9sbL7jtnwjonroAJUZNr59v33hpXDa7FJHfjke9fznAYSLkT/yLx
p+2gV1UwyTayEWNW6/96D1vp4NPMGsRB2r746Vs5G4wFDGsQuOuuyuT8cbEXgsz7
R3rxRQdRpPqob8RCN7K6TIvmT789ZgCOIFMZq0D4zrq3jbaWjlGSFkFR++EfdQl4
VgXI4nBXUiklQYgp7QxApeS4y5V0htY4ndfkGrDBAFj5w4cRblHQKk/qgzlSxn4e
IVnSkP0EQ2Z+3eqANu/ipIWgUYpbSVFk6gigT6exSKdgo/EM/sxHOuAOkLoYe/nL
Alw6oLBdlinEVOegXD0pBy2goxBFXy1nAgMBAAGjNzA1MBQGA1UdEQQNMAuCCWxv
Y2FsaG9zdDAdBgNVHSUEFjAUBggrBgEFBQcDAQYIKwYBBQUHAwIwDQYJKoZIhvcN
AQELBQADggEBACyC4H+OjA/u0aG29DLuV/O/MR+4bJ0bumDVYo/R0Z0wQfYblebz
PxadmNTXgRrTHN6GVlYLfjnSF06BqgUQzvQs9vjDFN58ZR0jtJqjVRq7ISkiKkgM
BoHPKxGtPjubGEnBqahVJ7gwQZba3IkmY8cXBwEN7dnyV1fP7m3gJzja1kiK+i6g
x5rfBiUaTf2CoIUtnDVwO9JqUYbucAM0Kb1YVRzjWoc9E41/B/i/eDKA+6U7XEXV
8M7wFkLqrkCeP/5SLJU6d4jo2A0KkaUFOzx7m6PrhvSc+90N10zWwLo+6jGKYP5F
SrB3vZg1a4CFVjIosT6DvLDWKlS1NPBK5MU=
-----END CERTIFICATE-----
`,
  "server.key": `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCo9sbL7jtnwjon
roAJUZNr59v33hpXDa7FJHfjke9fznAYSLkT/yLxp+2gV1UwyTayEWNW6/96D1vp
4NPMGsRB2r746Vs5G4wFDGsQuOuuyuT8cbEXgsz7R3rxRQdRpPqob8RCN7K6TIvm
T789ZgCOIFMZq0D4zrq3jbaWjlGSFkFR++EfdQl4VgXI4nBXUiklQYgp7QxApeS4
y5V0htY4ndfkGrDBAFj5w4cRblHQKk/qgzlSxn4eIVnSkP0EQ2Z+3eqANu/ipIWg
UYpbSVFk6gigT6exSKdgo/EM/sxHOuAOkLoYe/nLAlw6oLBdlinEVOegXD0pBy2g
oxBFXy1nAgMBAAECggEAGB+Pl3sZGSx2WscDubuKCucXapwCcmOzjFWza5bLhd1h
TLOeqle2w1N1+PqvC4rsLQqQKSStnN2Hgmyai0gBCuPyeHLyFsUI6ImdhE2FPLdJ
b9oYQ3fl0InOkuwyP3peB+FZNG5jrUyTfBuY/Wj28v5zeYqP+VX5UOPslIdCPH3c
jHDpoEEF3Fcvea+sXTjxGlUWaWD9InydZtTmqFRNsJcwoFEjpgHFiyYSV3JN//CG
H79gXAhy1o3YE3bFs3sC16c1BOUeKHrKgfMpWQJG2p5lyOLGkrRDmUcDEbvXJBw0
QCWAkFClZ81Tds+R+vGuk1R0jBiwaDtHHcMBQ2TsJQKBgQDRM0Dvbq6LHGuNRo7w
ZqeqIJ2eMe+fVoq+YxIJ/WX1/wdFvwHqOkTRo7iwhRmIMPIVcV8rorhs2e9gT6nr
7KGGH4/0+P4FC4F4qTFoRD2GzjdDiGWaCbKQH+cFlLFGMPdGUsYC2sIczO4DysLZ
LS0mDd/Uwm3nCKrwGoCe7XIvfQKBgQDOwzjoACoe6M7R14r/XI9GBA5TytXj7Np6
pABt8UgG7ZmVaN5auaMtWi8mMj7VOZK92ylUuZ0ApTLUD6nH93Xtj0mZgXRurMbB
9hcg1NUMYxKlOtisBIEVgC/FVTrtW4GsoSekSljGpBwlEerCk+dhFPYdTHUpCQbM
2eSU8hstswKBgQCR/YmYTY5DCD9KJO5Fd+4TvJUiO8j0UimauXpyPEL2S9YgZy6H
7cfu4KlXjlsF/tpB+o8m3XSEigYSGSYEvWrvNYF5vHVQwfnFYZVYJR8mvywz1bDJ
sXDKQWkwLNcVm8BEdCk4/r6t6JlFTi9x7aPvRYlpaZHWw+a+jlAqGJwx5QKBgFqn
IYYmvFD9BeDfPiQkMvUhxh5a6liaelgXG9EYXtoaxqHJbuQcTD0QM2ft07qtGXeA
ZaiuEPY9eAGeNHRmPSBBGKXjKmdz/VkBSrasWhSqQ3yKRoF1IBuLLma4rbNv0XUc
20KfDjlZrrVaG7HgIyxfgmDqKtwpBwA98IiVdfEdAoGAcVSgzmIPLaR6aA6i6wGx
QFNNu2EBkg3nMXAbVsKRMYfcU5iPUESD7jfp5hyJPU6Fw/MvpEHDPuPQLfo8iqom
QVpi78eErGjiGrjBlERFNrSh5lz71bNx4wUPKKElJQmec0T0k+ST7/1usfjNKs9K
rajcAjo39/sfxdp/7fab4FI=
-----END PRIVATE KEY-----
`,
  "client.crt": `-----BEGIN CERTIFICATE-----
MIIC5jCCAc6gAwIBAgIULXWisBrp16sbCccV5zpjmkesD28wDQYJKoZIhvcNAQEL
BQAwDTELMAkGA1UEAwwCY2EwHhcNMjYxMTA0MjE1NzQwWhcNMzYxMTAxMjE1NzQw
WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAw
ggEKAoIBAQCuom6eI8FFRDTa/FcA0BJrzvB0PG+J8Rob/2OaPlI2MJInDCOyl9Ac
HWOYV1e6EkGvUKQEjN4ORk/lSGibrJRFB9Mua8/htAohE0WUz/GYCFZEZP7qmVWj
e7/KLdlsH+hkGqnCoUI3nxeWyMfKiWDxM53ab0lcAYwByuJ7853Ml8z521oi/Tsm
zeqXFVHqdGMpOVLR3ZJcZUwv7x9wi0SpQcYjkymptA50ohBwC8iPS0outK+I3MUc
mvUzsk4/K62spZMMomFy4AvLyCkijD988ZCsfIMZ095dIB7x9nVuFw2AmPU5DP0W
WOtKaez8G2CQiwkBCsunto/GGEKw4Q/VAgMBAAGjNzA1MBQGA1UdEQQNMAuCCWxv
Y2FsaG9zdDAdBgNVHSUEFjAUBggrBgEFBQcDAQYIKwYBBQUHAwIwDQYJKoZIhvcN
AQELBQADggEBABht2N8Pubnyb0weH6zwIIHl2Z4MjLiNlVtNm1UKSXLUaM+JXuqP
ymcZvBNk+ATSwc6c5OjQTymZ0kN4cixsi6cTPTu5L4ZLqSMHRKJfBCZS4bLUq/r4
DMwZ6IfmiP/S4jLoREzeP4vbM4r3eIDP1WQCQELoVuG8X12wAwG0rntoyrA5Qkap
dMbbPD97csiBby8bVbTCQZTCgHQymDX8cX5Oz4hVWgkdF8udIq0qPYNtcEF5h+po
xNxCI634V8V53dOCdsZKdRXwMfMuliV2IU9ZXRKcoqzShiR+HaX6BUHLZ5PluXPe
12ipoIiO+tVtzK2ygtFJjvUIZ8K24tuB8oc=
-----END CERTIFICATE-----
`,
  "client.key": `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCuom6eI8FFRDTa
/FcA0BJrzvB0PG+J8Rob/2OaPlI2MJInDCOyl9AcHWOYV1e6EkGvUKQEjN4ORk/l
SGibrJRFB9Mua8/htAohE0WUz/GYCFZEZP7qmVWje7/KLdlsH+hkGqnCoUI3nxeW
yMfKiWDxM53ab0lcAYwByuJ7853Ml8z521oi/TsmzeqXFVHqdGMpOVLR3ZJcZUwv
7x9wi0SpQcYjkymptA50ohBwC8iPS0outK+I3MUcmvUzsk4/K62spZMMomFy4AvL
yCkijD988ZCsfIMZ095dIB7x9nVuFw2AmPU5DP0WWOtKaez8G2CQiwkBCsunto/G
GEKw4Q/VAgMBAAECggEAF7aAtMKAJOqtDqtDGR4n0jHIXtAyCRYPCIw2NySNP0R7
JAg29LI+lQK8mlwJ0n9WIfseOmvyXxfXE3gwlCrr+y+j0mLbWHd9BJ68TQerc4x2
QlVAdBScF1XfZhGxu0fd43HnaUFCX5Efv97Fmk/rNPVgUt/Xo0GmhDvLYy9iVvxw
byp6AvWwoo/MWqCyu409/6UsFhG+NpiRAIOS7NXReH1X3I/XcdesEFca4DZBJu0X
a4/wmISizst9seM+Z3OJGZyRIpXRD4iRWf9vvh5+dObV+fPlLGnLgxcRRUS+5Kjb
kK25fhCblVO/lP8c6+3HKxBmG6a79+LZBTpR13sIhQKBgQDXkY36F14/Qa9s2072
0NSy9Zw6uW5wUYSP67GruFwJJilWE8SobPjsDHr/XuZCkelHEMVeIXgAHxCmlM2B
ItU6emaOH2MFK8GgECUh2sLmCdWbateG+jbNeyOdZzfTTkRzluOEdVwmmTFcWURQ
/Y2rpKGV7ssxS2nnjSKoTBJTywKBgQDPY3FxuYceaJK2n3dhGvKjJP61j4G8vj+J
AD8UQgQSn/uwarhEfWV/NbCgJXPYogos+7heMTB9bwwep5ysWoFplXIAjLwTqLyk
5/HM+1+zDF9zFzAK0I/dKZmmungXXjneiUXC0JNci9hV/XfUHjwmEVnAgufYTrKj
ykgpxo/23wKBgDqzQgwWDO4AvvpPheMj3qeUxiQflnkzWXuvXMQ8AaPkJmFwJJ8Q
fYAZreyYNO9vuCxH3tbRGlI+I1SZNJSznYi9B+wvk9E2pxUlEFd1sJjfmLEnmOUC
gaXWoE4ea085At7O+cl6A8vm71AMZtP/F3Lj87RWQDJ+LKqG/icCAAOdAoGAWAz/
kGpV3OpHSDRCaj8Xv36oiguI6MrZjOBG5+HzerjkEo3s+F9JJY51FDlyiwqZSWoC
aDN4Q/lO6wD8+wxeH6bsxSD7hVlB5r33orEje5CIQgQZSK4uNpc//lLzQ/Ckn0An
F0SZHFTfn/rC0pOXtA3vzlWF/AfFvtbWdq4wV38CgYBiodHTQlKV7gB64JyXwZTE
ZFrxOFBiOZcm8jVfJoEWHTzDZFwCrXqy6Se4rHt8xtoZzlW2qGAyTELmD4SJ9uOx
uqmq4IuA1dutT6MXLbS/qFAob0ssvFPYKYnaXW+y6edcZa/Em2qemfSxFkeEPSOY
AxBiaXwpBv+schrgV/i+qQ==
-----END PRIVATE KEY-----
`,
  "rogue.crt": `-----BEGIN CERTIFICATE-----
MIIC6TCCAdGgAwIBAgIUXh5tMLx8VOK+R5zrpKFAQ9n/gDwwDQYJKoZIhvcNAQEL
BQAwEDEOMAwGA1UEAwwFb3RoZXIwHhcNMjYxMTA0MjE1NzQwWhcNMzYxMTAxMjE1
NzQwWjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEBAQUAA4IB
DwAwggEKAoIBAQCmtLq2CMBUNDePABfPO13mhZRUtHGiqHZsQYO10bMyDMJexNH1
cGkpFzNfPEphtf94RokEPfcwelNrsKVUOvl0vuVQVLfKy9Awwt5EsrT0RJFuxZUk
01/qQRSFeiIWVu8pn+ohrlkccNv5oGy0j4PfoI15rSdwSbJLhBnEOYAb1Wfs7U2u
86uDhtu336eusZB2GuVOaEfWzicVmx5K65ib9hPMGirKbBaj4HCPlssYaVzwYW+h
QHxpB/9ZrhfGUZkOFc2eqNxe/ImZ6vb03DU2bCPl343E7+Pskhg1Fk1Zzd1UxJFE
qO4xZaoM19Yb99RwEmnJieXs60LZIEsydYqBAgMBAAGjNzA1MBQGA1UdEQQNMAuC
CWxvY2FsaG9zdDAdBgNVHSUEFjAUBggrBgEFBQcDAQYIKwYBBQUHAwIwDQYJKoZI
hvcNAQELBQADggEBABcpbe3jnPrs5VvE+TTvzhEOpAFmdFYdGINyagcocvxsApDS
0jJZ/B1dX41cEhCd3zoAzsJ8rYAm8KomCi9QDv1IkLrpLe6H5Z8697u5Z8xJ/GLU
YhXfJiSHaq6v54W+pZx6lD0D+4unbSg3GkkfZ8jCgsDm8E/Jt6R+hqSyQAj9l7cl
s72Y35+d0hYuTcJrinpB+HHoLdo+JqFuqkoYPK5EuV+HtG5ZOpyCod10+s5w6yUZ
iUqFrBBRCX78ChPvtJvzWqR4SxlQyFyjOvk/ntqYIHAp5NUz0MBGvD78CQjfk1C5
S1eaW3yFB88yRvhMV34aaxuCp5i7ss1KhkQUUj0=
-----END CERTIFICATE-----
`,
  "rogue.key": `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCmtLq2CMBUNDeP
ABfPO13mhZRUtHGiqHZsQYO10bMyDMJexNH1cGkpFzNfPEphtf94RokEPfcwelNr
sKVUOvl0vuVQVLfKy9Awwt5EsrT0RJFuxZUk01/qQRSFeiIWVu8pn+ohrlkccNv5
oGy0j4PfoI15rSdwSbJLhBnEOYAb1Wfs7U2u86uDhtu336eusZB2GuVOaEfWzicV
mx5K65ib9hPMGirKbBaj4HCPlssYaVzwYW+hQHxpB/9ZrhfGUZkOFc2eqNxe/ImZ
6vb03DU2bCPl343E7+Pskhg1Fk1Zzd1UxJFEqO4xZaoM19Yb99RwEmnJieXs60LZ
IEsydYqBAgMBAAECggEAAMC0TtewjzVZcE2mu5YJHJUB+Yen6kZTv7WI4YEVHf2q
5rumEjNK0I5T5/xBNXFQTICFmyann02hh80HChaK8RtetLXMFBb9p74jzhTkyLZw
jNG2lJ8Pb5m2WDlhLCrLU4cl1CT2d+d61/KlbUy5dO6Mu9lHGRkPhYsO8nD0UDT/
QryQw8PHbQpeF31UCVnUQsYv4eNqNfdlR5BMz9D1U7gBdRXvV7SvP/7l3PUMJaAg
kTFCE1p6+vtbPQ1Nvn4ilPJxD2JYZQavPUxb2T5V2tFSYtbdV58ZPvNgaIKcbVJ1
0BYjtIZkHb4c4355p66UcT3wG5bBSqVEvh/qkoqK2QKBgQDT0GpQfjWTldmbtx9Z
ZwHk8//hHBa7fFwaG+bjvKJvfKbrQCNjxlJAPC+JDiduEN/AbyzebbkdRkdmkiiY
uauDqQBGQAxKGzzMCC5ZQC7ysLyffpJIwVBJbQOQnvjxczFI3eLiRiyPnz2GkoW/
RvKAMqwS2qLDC1Ir80CTFnctzQKBgQDJe2M6M4wQLOHX4prGreGP6/+hkyKQKdj3
kbPnaHu0jg9MrVzLZ685fENY9KED1stgKtlhCAqS8wFpCE3Aeg++Unb3jBwdKI3k
gzFV8JQWdNlrq9u533cPTWZs/ZkOmKrMd+lXK6Iv3WfLFgcxc57VebAQCSi880ev
DtPO8m67hQKBgHaCmblHpDpbEVHqd4PR+mFbk8MjsCReRDnnepvZIxk1qT7et+5P
PB3sjrwkSzNuBYLpsTUSNwyGEdT12fj5iVk06Y5kr3uXGcEeorAVFS98a0zhyH8k
igNLFz+HcsnFJcIbQ6JOmQgSlJ4CxQpsa6oGr/gsk/yFDQjCJVMmsq/RAoGBAIRH
aP8mJpfcD65gDQPR1xxZceyPoAqMHvFzDG0qUMVa2zqZOyoj+YvBRKobebb+h2ms
2Cj3UZHmzw85L2rl+H4YwBiIOVD/diEH7RUiLOeNcc1Z+JlQ2GcIhu2ZlapamxBA
zca4U/Qe5W0VGkXiRe6bxPbSPJfJFVAeaPseeYrNAoGAAk7RcxIZsx4KPpKSfjq+
ttGJP2JS6NYPD1yBpQjD+tqv6kNWQES0FwiFxCqTqPMJOephaiu8zVmH24CgR7PM
i6QuP7q7QRCHf4U/iLeNGcWNK0tZa3PjMaNewJMOk8Mn07a/646R93Y8JOgZ3wTr
kY8PkD/6ilK3LF9Y9zVDO7Q=
-----END PRIVATE KEY-----
`
};
const pin = (cert: { raw: Buffer }) =>
  createHash("sha256").update(cert.raw).digest("hex");
const socketErrors: Error[] = [];
const onSocketError = (error: Error) => {
  socketErrors.push(error);
};
const serverIdentity = {
  cert: fixtures["server.crt"],
  key: fixtures["server.key"],
  ca: fixtures["ca.crt"],
  onSocketError,
  expectedPeerId: "client"
};
const clientIdentity = {
  cert: fixtures["client.crt"],
  key: fixtures["client.key"],
  ca: fixtures["ca.crt"],
  onSocketError,
  expectedPeerId: "server"
};
const verify = (cert: { raw: Buffer }) => pin(cert) === pinValue;
let pinValue = "";
let stop: (() => Promise<void>) | undefined;
afterEach(async () => {
  await stop?.();
  stop = undefined;
});

async function start(
  accept: (socket: TLSSocket) => void,
  verifyPeer: (cert: { raw: Buffer }) => boolean = () => true
) {
  const server = await listenPeerOnline({
    ...serverIdentity,
    host: "127.0.0.1",
    port: 0,
    handshakeTimeoutMs: 300,
    verifyPeer,
    onError: (error: Error) => {
      socketErrors.push(error);
    },
    onConnection: accept
  });
  stop = server.close;
  return server.port;
}

describe("peer online TLS", () => {
  it("requires an explicit listener error policy and expected peer identity", async () => {
    await expect(
      listenPeerOnline({
        ...serverIdentity,
        host: "127.0.0.1",
        port: 0,
        handshakeTimeoutMs: 300,
        verifyPeer: () => true,
        onConnection: () => {}
      } as unknown as Parameters<typeof listenPeerOnline>[0])
    ).rejects.toThrow();
    expect(() =>
      connectPeerOnline({
        ...clientIdentity,
        expectedPeerId: "",
        host: "127.0.0.1",
        port: 1,
        servername: "localhost",
        handshakeTimeoutMs: 300,
        verifyPeer: () => true
      })
    ).toThrow();
  });

  it("passes expected peer identity to the pin verifier", async () => {
    const port = await start(() => {});
    let received: string | undefined;
    const socket = await connectPeerOnline({
      ...clientIdentity,
      host: "127.0.0.1",
      port,
      servername: "localhost",
      handshakeTimeoutMs: 1000,
      verifyPeer: (cert, identity) => {
        received = identity;
        return pin(cert) === pinValue;
      }
    });
    expect(received).toBe("server");
    socket.destroy();
  });

  it("times out a client against a stalled TCP server", async () => {
    const stalled = createNetServer((socket) => {
      socket.on("error", () => {});
      socket.resume();
    });
    await new Promise<void>((resolve) =>
      stalled.listen(0, "127.0.0.1", resolve)
    );
    const address = stalled.address();
    if (!address || typeof address === "string")
      throw new Error("missing address");
    try {
      await expect(
        connectPeerOnline({
          ...clientIdentity,
          host: "127.0.0.1",
          port: address.port,
          servername: "localhost",
          handshakeTimeoutMs: 50,
          verifyPeer: verify
        })
      ).rejects.toThrow("timed out");
    } finally {
      await new Promise<void>((resolve) => stalled.close(() => resolve()));
    }
  });

  it("does not deliver a connection when shutdown starts inside pin verification", async () => {
    let delivered = false;
    let closing: Promise<void> | undefined;
    const port = await start(
      () => {
        delivered = true;
      },
      () => {
        closing = stop?.();
        return true;
      }
    );
    const socket = await connectPeerOnline({
      ...clientIdentity,
      host: "127.0.0.1",
      port,
      servername: "localhost",
      handshakeTimeoutMs: 1000,
      verifyPeer: verify
    });
    await new Promise<void>((resolve) => socket.once("close", () => resolve()));
    await closing;
    expect(delivered).toBe(false);
  });
  it("reports connection callback failures and closes the socket", async () => {
    const before = socketErrors.length;
    const port = await start(() => {
      throw new Error("callback failed");
    });
    const socket = await connectPeerOnline({
      ...clientIdentity,
      host: "127.0.0.1",
      port,
      servername: "localhost",
      handshakeTimeoutMs: 1000,
      verifyPeer: verify
    });
    await new Promise<void>((resolve) => socket.once("close", () => resolve()));
    expect(
      socketErrors
        .slice(before)
        .some(
          (error) =>
            error.message === "Peer connection callback failed" &&
            (error.cause as Error).message === "callback failed"
        )
    ).toBe(true);
  });

  it("mutually validates, pins certificates and derives matching exporter binding", async () => {
    let accepted!: (socket: TLSSocket) => void;
    const incoming = new Promise<TLSSocket>((resolve) => {
      accepted = resolve;
    });
    const port = await start(accepted, (cert) => pin(cert) === clientPin);
    const socket = await connectPeerOnline({
      ...clientIdentity,
      host: "127.0.0.1",
      port,
      servername: "localhost",
      handshakeTimeoutMs: 1000,
      verifyPeer: verify
    });
    const peer = await incoming;
    expect(socket.alpnProtocol).toBe(PEER_ONLINE_ALPN);
    expect(
      socket.exportKeyingMaterial(
        32,
        "EXPORTER-koed-peer-online",
        Buffer.alloc(0)
      )
    ).toEqual(
      peer.exportKeyingMaterial(
        32,
        "EXPORTER-koed-peer-online",
        Buffer.alloc(0)
      )
    );
    socket.destroy();
  });

  it("rejects a server not signed by the pretrusted CA", async () => {
    const port = await start(() => {});
    await expect(
      connectPeerOnline({
        ...clientIdentity,
        ca: fixtures["rogue.crt"],
        host: "127.0.0.1",
        port,
        servername: "localhost",
        handshakeTimeoutMs: 1000,
        verifyPeer: () => true
      })
    ).rejects.toThrow();
  });

  it("rejects an unexpected server pin", async () => {
    const port = await start(() => {});
    await expect(
      connectPeerOnline({
        ...clientIdentity,
        host: "127.0.0.1",
        port,
        servername: "localhost",
        handshakeTimeoutMs: 1000,
        verifyPeer: () => false
      })
    ).rejects.toThrow();
  });

  it("does not deliver a client with unexpected pin", async () => {
    let delivered = false;
    const port = await start(
      () => {
        delivered = true;
      },
      () => false
    );
    const socket = await connectPeerOnline({
      ...clientIdentity,
      host: "127.0.0.1",
      port,
      servername: "localhost",
      handshakeTimeoutMs: 1000,
      verifyPeer: () => true
    });
    await new Promise<void>((resolve) => socket.once("close", () => resolve()));
    expect(delivered).toBe(false);
  });

  it("does not deliver an unauthorized client certificate", async () => {
    let delivered = false;
    const port = await start(() => {
      delivered = true;
    });
    const socket = tlsConnect({
      host: "127.0.0.1",
      port,
      servername: "localhost",
      ca: fixtures["ca.crt"],
      cert: fixtures["rogue.crt"],
      key: fixtures["rogue.key"],
      ALPNProtocols: [PEER_ONLINE_ALPN]
    });
    await new Promise<void>((resolve) => {
      socket.on("error", () => {});
      socket.once("close", () => resolve());
    });
    expect(delivered).toBe(false);
  });

  it("rejects wrong ALPN", async () => {
    let delivered = false;
    const port = await start(() => {
      delivered = true;
    });
    const socket = tlsConnect({
      ...clientIdentity,
      host: "127.0.0.1",
      port,
      servername: "localhost",
      ALPNProtocols: ["wrong"]
    });
    await new Promise<void>((resolve) => {
      socket.on("error", () => {});
      socket.once("close", () => resolve());
    });
    expect(delivered).toBe(false);
  });

  it("shutdown closes established connections", async () => {
    let accept!: (socket: TLSSocket) => void;
    const incoming = new Promise<TLSSocket>((resolve) => {
      accept = resolve;
    });
    const port = await start(accept);
    const socket = await connectPeerOnline({
      ...clientIdentity,
      host: "127.0.0.1",
      port,
      servername: "localhost",
      handshakeTimeoutMs: 1000,
      verifyPeer: () => true
    });
    await incoming;
    const closed = new Promise<void>((resolve) =>
      socket.once("close", () => resolve())
    );
    await stop?.();
    await closed;
    stop = undefined;
  });

  it("times out incomplete handshakes", async () => {
    const before = socketErrors.length;
    const port = await start(() => {});
    const socket = netConnect(port, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.once("close", () => resolve());
    });
    expect(socket.destroyed).toBe(true);
    expect(
      socketErrors
        .slice(before)
        .some((error) => error.message === "Peer TLS handshake timed out")
    ).toBe(true);
  });

  it("shutdown closes incomplete handshakes", async () => {
    const port = await start(() => {});
    const socket = netConnect(port, "127.0.0.1");
    const closed = new Promise<void>((resolve) =>
      socket.once("close", () => resolve())
    );
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    await stop?.();
    await closed;
    stop = undefined;
  });
});

import { X509Certificate } from "node:crypto";
pinValue = pin(new X509Certificate(fixtures["server.crt"]));
const clientPin = pin(new X509Certificate(fixtures["client.crt"]));
