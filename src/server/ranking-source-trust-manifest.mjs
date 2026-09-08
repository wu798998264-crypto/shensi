export const RANKING_SOURCE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAH4SG3/as99zmY7niml+1RkiKdPu/0VXBaiLsh8TfIMk=
-----END PUBLIC KEY-----
`;

export const RANKING_SOURCE_TRUST_MANIFEST = Object.freeze({
  "src/server/ranking-sources/shared-html.mjs": Object.freeze({ sha256: "4b3177687cc46fa7fb11c5700a9aa98a9dff9a34fdafcae3416e89bcdd262b77", signature: "8FA42tr20/LHGcHQVacVAqMPcopIfxen3WybV0Kvw0xEuGKBXMV7bDEGinTx2i6zKGayPmi05tiWNZ2ZXnTDBA==" }),
  "src/server/ranking-sources/qidian.mjs": Object.freeze({ sha256: "d7a1b682ba24ce4a3a9177a69c1f667be89b16e477e2fd83a40d1400979bd306", signature: "avTNfDZnNVKSQKXnWR6om4QWISivX61/4dRjN00EpY+3Matf0EEKlnyzLyppt+GHiUzgZ7zVSxYXk7ffTiLYAw==" }),
  "src/server/ranking-sources/jjwxc.mjs": Object.freeze({ sha256: "9b0fec896a0c24365ca6d12d21e9c53394024fbb8f630a61872852347723a83c", signature: "2m/nFeJQribcXgeBO3BzGRdRGTdNensfkXdnJsnld/+ikGmR0YY3t01a3QiFW6H36JB8eo5+GTtswRYakbdyAw==" }),
  "src/server/ranking-collectors.mjs": Object.freeze({ sha256: "a03633ac8491918971e5f291058120a06a55976f69fa39778ee3d1b2cba9d6ac", signature: "2+8F1BfZ8nGI45tKh7AHFtMQ+HcdmQGSHMTkdVf60VI5h2tFuUrG4//zNJ037OOz3OayqafqHwGIz9bIIJOzCA==" }),
});

export const RANKING_SOURCE_FILES = Object.freeze({
  qidian: Object.freeze(["src/server/ranking-sources/shared-html.mjs", "src/server/ranking-sources/qidian.mjs", "src/server/ranking-collectors.mjs"]),
  jjwxc: Object.freeze(["src/server/ranking-sources/shared-html.mjs", "src/server/ranking-sources/jjwxc.mjs", "src/server/ranking-collectors.mjs"]),
  fanqie: Object.freeze(["src/server/ranking-collectors.mjs"]),
  qimao: Object.freeze(["src/server/ranking-collectors.mjs"]),
  ciweimao: Object.freeze(["src/server/ranking-collectors.mjs"]),
  dianzhong: Object.freeze(["src/server/ranking-collectors.mjs"]),
  heiyan: Object.freeze(["src/server/ranking-collectors.mjs"]),
});
