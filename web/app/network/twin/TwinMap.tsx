'use client';
import 'leaflet/dist/leaflet.css';
import { MapContainer, TileLayer, CircleMarker, Polyline, Popup, useMapEvents } from 'react-leaflet';

// Plain types mirror the API shape (avoids importing server types into the bundle).
export interface MapData {
  sites: Array<{ id: string; name: string; type: string; latitude: number; longitude: number; address: string | null }>;
  devices: Array<{ id: string; name: string; device_kind: string; device_role: string; vendor: string | null; status: string; latitude: number; longitude: number; capacity: number | null; used_ports: number }>;
  customers: Array<{ id: string; full_name: string; account_number: string; phone: string | null; latitude: number; longitude: number; state: string; service_count: number; service_type: string | null }>;
  links: Array<{ id: string; kind: string; status: string; from_lat: number; from_lng: number; to_lat: number; to_lng: number }>;
  leads: Array<{ id: string; name: string; phone: string | null; stage: string; service_interest: string | null; latitude: number; longitude: number }>;
}
export interface Layers { sites: boolean; devices: boolean; customers: boolean; links: boolean; leads: boolean }

const CUSTOMER_COLOR: Record<string, string> = {
  online: '#16a34a', offline: '#d97706', suspended: '#dc2626', closed: '#9ca3af',
};
const DEVICE_COLOR: Record<string, string> = {
  olt: '#7c3aed', onu: '#a78bfa', fat: '#0d9488', splitter: '#14b8a6',
  tower: '#0891b2', ap_sector: '#06b6d4', pole: '#9ca3af', backhaul: '#f59e0b',
  router: '#2563eb', switch: '#3b82f6', cpe: '#a78bfa',
};
const LINK_COLOR: Record<string, string> = {
  fiber: '#7c3aed', backhaul: '#f59e0b', drop: '#0d9488', distribution: '#2563eb',
};

function ClickCapture({ onClick }: { onClick?: (lat: number, lng: number) => void }) {
  useMapEvents({ click: (e) => onClick?.(e.latlng.lat, e.latlng.lng) });
  return null;
}

export default function TwinMap({
  data, layers, placing, onMapClick, onDelete,
}: {
  data: MapData;
  layers: Layers;
  placing: boolean;
  onMapClick?: (lat: number, lng: number) => void;
  onDelete?: (kind: 'site' | 'device' | 'customer', id: string) => void;
}) {
  // Center on the data's mean, else Nakuru.
  const pts = [
    ...data.customers.map((c) => [c.latitude, c.longitude] as [number, number]),
    ...data.sites.map((s) => [s.latitude, s.longitude] as [number, number]),
    ...data.devices.map((d) => [d.latitude, d.longitude] as [number, number]),
    ...data.leads.map((l) => [l.latitude, l.longitude] as [number, number]),
  ];
  const center: [number, number] = pts.length
    ? [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length]
    : [-0.3031, 36.0800];

  return (
    <MapContainer
      center={center}
      zoom={13}
      style={{ height: '100%', width: '100%', cursor: placing ? 'crosshair' : '' }}
      scrollWheelZoom
    >
      <TileLayer
        attribution='&copy; OpenStreetMap'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <ClickCapture onClick={onMapClick} />

      {layers.links && data.links.map((l) => (
        <Polyline
          key={l.id}
          positions={[[l.from_lat, l.from_lng], [l.to_lat, l.to_lng]]}
          pathOptions={{ color: LINK_COLOR[l.kind] ?? '#7c3aed', weight: 2, opacity: l.status === 'down' ? 0.4 : 0.85, dashArray: l.status === 'planned' ? '6 6' : undefined }}
        />
      ))}

      {layers.sites && data.sites.map((s) => (
        <CircleMarker key={s.id} center={[s.latitude, s.longitude]}
          radius={8} pathOptions={{ color: '#1d4ed8', fillColor: '#2563eb', fillOpacity: 0.9, weight: 2 }}>
          <Popup>
            <strong>{s.name}</strong><br />Site · {s.type}
            {s.address ? <><br />{s.address}</> : null}
            {onDelete && <><br /><button onClick={() => onDelete('site', s.id)}>Delete</button></>}
          </Popup>
        </CircleMarker>
      ))}

      {layers.devices && data.devices.map((d) => (
        <CircleMarker key={d.id} center={[d.latitude, d.longitude]}
          radius={6} pathOptions={{ color: '#1f2937', fillColor: DEVICE_COLOR[d.device_kind] ?? '#64748b', fillOpacity: 0.9, weight: 1.5 }}>
          <Popup>
            <strong>{d.name}</strong><br />{d.device_kind}{d.vendor ? ` · ${d.vendor}` : ''}<br />
            role: {d.device_role} · {d.status}
            {d.capacity != null && <><br />ports: {d.used_ports}/{d.capacity}</>}
            {onDelete && <><br /><button onClick={() => onDelete('device', d.id)}>Delete</button></>}
          </Popup>
        </CircleMarker>
      ))}

      {layers.leads && data.leads.map((l) => (
        <CircleMarker key={l.id} center={[l.latitude, l.longitude]}
          radius={5} pathOptions={{ color: '#ca8a04', fillColor: '#facc15', fillOpacity: 0.6, weight: 1, dashArray: '2 2' }}>
          <Popup>
            <strong>{l.name}</strong> <em>(lead)</em><br />
            {l.phone || '—'}{l.service_interest ? ` · ${l.service_interest}` : ''}<br />
            stage: {l.stage}
          </Popup>
        </CircleMarker>
      ))}

      {layers.customers && data.customers.map((c) => (
        <CircleMarker key={c.id} center={[c.latitude, c.longitude]}
          radius={5} pathOptions={{ color: '#ffffff', fillColor: CUSTOMER_COLOR[c.state] ?? '#64748b', fillOpacity: 0.95, weight: 1.5 }}>
          <Popup>
            <strong>{c.full_name}</strong><br />{c.account_number}{c.phone ? ` · ${c.phone}` : ''}<br />
            <span style={{ textTransform: 'capitalize' }}>{c.state}</span>
            {c.service_type ? ` · ${c.service_type}` : ''} · {c.service_count} svc
            {onDelete && <><br /><button onClick={() => onDelete('customer', c.id)}>Remove pin</button></>}
          </Popup>
        </CircleMarker>
      ))}
    </MapContainer>
  );
}
