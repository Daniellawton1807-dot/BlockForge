/* Homebase service shortcuts. URLs use the existing Cloudflare Vault published applications.
   The third Sonarr route was not visible in the supplied screenshot, so its URL is intentionally blank.
   Keep API keys and passwords out of this public static file. */
window.HOMEBASE_CONFIG = {
  metricsEndpoint: "",
  refreshIntervalMs: 10000,
  services: [
    {name:"Sonarr",desc:"TV series management",url:"https://sonarr.danielvault.uk",icon:"S1",tone:"purple",group:"media"},
    {name:"Sonarr Mum",desc:"Second Sonarr instance",url:"https://sonarrmum.danielvault.uk",icon:"S2",tone:"purple",group:"media"},
    {name:"Sonarr 3",desc:"Sonarr Extra",url:"http://192.168.8.150:8991",icon:"S3",tone:"purple",group:"media"},
    {name:"Radarr",desc:"Movie library management",url:"https://radarr.danielvault.uk",icon:"R",tone:"blue",group:"media"},
    {name:"Prowlarr",desc:"Indexer management — URL to be added",url:"http://192.168.8.150:9696",icon:"P",tone:"orange",group:"media"},
    {name:"Seerr",desc:"Media requests",url:"https://seerr.danielvault.uk",icon:"O",tone:"purple",group:"media"},
    {name:"SABnzbd",desc:"Usenet downloads",url:"https://sab.danielvault.uk",icon:"S",tone:"orange",group:"downloads"},
    {name:"qBittorrent",desc:"Torrent downloads",url:"https://qb.danielvault.uk",icon:"qB",tone:"green",group:"downloads"},
    {name:"Jellystat",desc:"Jellyfin statistics",url:"https://jellystat.danielvault.uk",icon:"J",tone:"blue",group:"media"},
    {name:"Jellyfin",desc:"Your media library",url:"https://jellyfin.danielvault.uk",icon:"J",tone:"blue",group:"media"},
    {name:"CasaOS",desc:"Server app management",url:"https://casa.danielvault.uk",icon:"C",tone:"green",group:"system"},
    {name:"Crafty",desc:"Minecraft server management",url:"https://minecraft.danielvault.uk/panel",icon:"MC",tone:"green",group:"system"}
  ]
};
