/* Copy this object into config.js and replace each URL with your own LAN or secure access URL.
   Keep API keys and passwords out of this public static file. */
window.HOMEBASE_CONFIG = {
  metricsEndpoint: "", // e.g. a secured HTTPS endpoint served by a monitoring agent on your server
  refreshIntervalMs: 10000,
  services: [
    {name:"Sonarr",desc:"TV series management",url:"",icon:"S",tone:"purple",group:"media"},
    {name:"Radarr",desc:"Movie library management",url:"",icon:"R",tone:"blue",group:"media"},
    {name:"Prowlarr",desc:"Indexer management",url:"",icon:"P",tone:"orange",group:"media"},
    {name:"qBittorrent",desc:"Torrent downloads",url:"",icon:"qB",tone:"green",group:"downloads"},
    {name:"SABnzbd",desc:"Usenet downloads",url:"",icon:"S",tone:"orange",group:"downloads"},
    {name:"Jellyfin",desc:"Your media library",url:"",icon:"J",tone:"blue",group:"media"},
    {name:"Overseerr",desc:"Media requests",url:"",icon:"O",tone:"purple",group:"media"},
    {name:"CasaOS",desc:"Server app management",url:"",icon:"C",tone:"green",group:"system"}
  ]
};