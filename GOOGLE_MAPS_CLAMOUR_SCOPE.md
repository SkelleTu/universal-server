# Google Maps Platform scope for Clamour

This is the runtime API set for the open-world Araras experience.

## Core now

- Street View Static API: street-level visual reference and on-demand imagery.
- Geocoding API: address ↔ coordinates and reverse geocoding.
- Places API / Places API (New): points of interest and place context.
- Roads API: road snapping and road geometry context where needed.
- Elevation API: terrain height and slope data.
- Routes API: navigation, travel paths and route calculations.
- Time Zone API: correct local-time rules for world simulation.
- Weather API: current real-world weather used by the synchronized environment layer.

## Future / optional

- Map Tiles API / Street View Tiles: richer immersive map/tiles pipeline when the client architecture is ready.
- Photorealistic 3D / Maps 3D: aerial/3D context; not a replacement for street-level Street View.
- Aerial View API: aerial video/overview features.
- Navigation SDK: dedicated navigation UX if the gameplay later needs turn-by-turn navigation.

## Not required for the core Unity gameplay client

- Maps JavaScript API: browser-specific mapping layer.
- Maps Embed API: browser embed use cases.
- Maps SDK for Android/iOS: native mobile clients only.
- Address Validation API: useful for forms/address input, not required for the open-world core.
- Geolocation API: useful for device positioning, not required for the authoritative Araras world coordinates.
- Maps Datasets API / Map Management API: optional tooling/data-pipeline features, not required for the base runtime loop.

## Architecture

The Unity client talks to the Universal Server. The server owns the Google API key and decides when an external request is necessary. Street View metadata and panorama identifiers can be retained as world references; imagery is requested on demand. The game stores its own world state separately.

The purpose is to keep Araras available as a continuous open world while avoiding duplicate external requests and keeping Google-specific credentials out of the client.
