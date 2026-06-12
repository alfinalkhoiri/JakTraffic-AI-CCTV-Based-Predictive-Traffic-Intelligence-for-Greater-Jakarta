import { useEffect } from "react";
import { useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet-routing-machine";

export default function TrafficRoute({
  start,
  end,
  severity,
  onETA,
}) {
  const map = useMap();

  useEffect(() => {
    if (!start || !end) return;

    const color =
      severity === "CRITICAL"
        ? "#ef4444"
        : severity === "WARNING"
        ? "#f59e0b"
        : "#22c55e";

    const router = L.Routing.control({
      waypoints: [
        L.latLng(start.lat, start.lng),
        L.latLng(end.lat, end.lng),
      ],
      addWaypoints: false,
      draggableWaypoints: false,
      fitSelectedRoutes: true,
      show: false,
      lineOptions: {
        styles: [{ color, weight: 6 }],
      },
      createMarker: () => null,
    }).addTo(map);

    router.on("routesfound", (e) => {
      const baseTime = e.routes[0].summary.totalTime / 60;

      const factor =
        severity === "CRITICAL"
          ? 1.5
          : severity === "WARNING"
          ? 1.25
          : 1;

      onETA(Math.round(baseTime * factor));
    });

    return () => map.removeControl(router);
  }, [start, end, severity, map, onETA]);

  return null;
}
