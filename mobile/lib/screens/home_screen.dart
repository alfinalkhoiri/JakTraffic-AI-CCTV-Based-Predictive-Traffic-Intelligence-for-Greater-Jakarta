import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:flutter_map_dragmarker/flutter_map_dragmarker.dart';
import 'package:flutter_map_marker_cluster/flutter_map_marker_cluster.dart';
import 'package:latlong2/latlong.dart';
import 'package:provider/provider.dart';
import '../providers/route_provider.dart';
import '../providers/traffic_provider.dart';
import '../models/cctv_status.dart';
import '../services/route_service.dart';
import '../theme/app_theme.dart';
import '../widgets/status_badge.dart';
import '../widgets/status_legend_sheet.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  final MapController _mapController = MapController();
  final TextEditingController _searchController = TextEditingController();
  static const _jakartaCenter = LatLng(-6.2088, 106.8456);

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final provider = context.read<TrafficProvider>();
      provider.fetchData();
      provider.startAutoRefresh();
    });
  }

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Consumer2<TrafficProvider, RouteProvider>(
      builder: (context, provider, route, _) {
        final cctvById = {for (final c in provider.cctvList) c.id: c};

        // One-shot side effects driven by provider state: load toll corridor
        // overlays once camera data exists, and honor chatbot fly-to requests.
        if (provider.allCctvList.isNotEmpty) {
          route.ensureTollCorridors(provider.allCctvList);
        }
        final flyTo = provider.flyToTarget;
        if (flyTo != null) {
          WidgetsBinding.instance.addPostFrameCallback((_) {
            if (!mounted) return;
            provider.consumeFlyTo();
            _mapController.move(flyTo, provider.flyToZoom);
          });
        }

        return Stack(
          children: [
            // Map
            FlutterMap(
              mapController: _mapController,
              options: MapOptions(
                initialCenter: _jakartaCenter,
                initialZoom: 11.5,
                maxZoom: 18,
                minZoom: 9,
                backgroundColor: AppColors.background,
                onTap: (_, latlng) => route.onMapTap(
                  latlng,
                  provider.cctvList,
                  cityOnly: provider.filterRoadType == 'city',
                ),
              ),
              children: [
                TileLayer(
                  urlTemplate: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
                  subdomains: const ['a', 'b', 'c', 'd'],
                  retinaMode: true,
                ),
                // Toll corridor overlay: glow + dashed main line per corridor
                if (route.tollCorridors.isNotEmpty)
                  PolylineLayer(
                    polylines: [
                      for (final c in route.tollCorridors) ...[
                        Polyline(
                          points: c.points,
                          color: c.color.withOpacity(0.18),
                          strokeWidth: 12,
                        ),
                        Polyline(
                          points: c.points,
                          color: c.color.withOpacity(0.9),
                          strokeWidth: 5,
                          isDotted: true,
                        ),
                      ],
                    ],
                  ),
                if (route.hasRoute)
                  PolylineLayer(
                    polylines: route.segments
                        .map((s) => Polyline(
                              points: s.points,
                              color: s.color,
                              strokeWidth: 5,
                              isDotted: s.dashed,
                            ))
                        .toList(),
                  ),
                if (route.waypointEtas.isNotEmpty)
                  MarkerLayer(markers: _buildWaypointEtaBadges(route)),
                MarkerClusterLayerWidget(
                  options: MarkerClusterLayerOptions(
                    maxClusterRadius: 60,
                    size: const Size(40, 40),
                    markerChildBehavior: true,
                    markers: provider.cctvList.map((cctv) => _buildMarker(cctv)).toList(),
                    builder: (context, markers) => _buildClusterMarker(markers, cctvById),
                  ),
                ),
                // Above the cluster layer so the origin/destination pins stay
                // grabbable even when they overlap a camera marker.
                if (route.start != null || route.end != null)
                  DragMarkers(markers: _buildRoutePins(provider, route)),
              ],
            ),

            // Top stats bar
            Positioned(
              top: MediaQuery.of(context).padding.top + 8,
              left: 12,
              right: 12,
              child: _buildStatsBar(provider),
            ),

            // Search bar
            Positioned(
              top: MediaQuery.of(context).padding.top + 64,
              left: 12,
              right: 12,
              child: _buildSearchBar(provider),
            ),

            // Filter chips
            Positioned(
              top: MediaQuery.of(context).padding.top + 116,
              left: 12,
              right: 12,
              child: _buildFilterChips(provider),
            ),

            // Loading indicator
            if (provider.isLoading && provider.allCctvList.isEmpty)
              const Center(child: CircularProgressIndicator(color: AppColors.primary)),

            // Routing hint (origin picked, waiting for destination)
            if (route.start != null && route.end == null)
              Positioned(
                top: MediaQuery.of(context).padding.top + 156,
                left: 12,
                right: 12,
                child: _buildRouteHint(),
              ),

            // Bottom info panel
            if (!provider.isLoading || provider.allCctvList.isNotEmpty)
              Positioned(
                bottom: 0,
                left: 0,
                right: 0,
                child: _buildBottomPanel(provider),
              ),

            // ETA card (route active/loading/error)
            if (route.end != null)
              Positioned(
                bottom: 170,
                left: 12,
                right: 64,
                child: _buildEtaCard(route),
              ),

            // Recenter button
            Positioned(
              bottom: 170,
              right: 12,
              child: FloatingActionButton.small(
                heroTag: 'recenter',
                backgroundColor: AppColors.surface,
                onPressed: () {
                  _mapController.move(_jakartaCenter, 11.5);
                },
                child: const Icon(Icons.my_location, color: AppColors.primary, size: 20),
              ),
            ),
          ],
        );
      },
    );
  }

  Marker _buildMarker(CctvStatus cctv) {
    final trafficProvider = context.read<TrafficProvider>();
    final isHighlighted = trafficProvider.highlightedIds.contains(cctv.id);
    // Chatbot-highlighted pins ring in blue, like the website's blue pins.
    final color = isHighlighted ? AppColors.primary : AppColors.statusColor(cctv.status);
    final isSelected = trafficProvider.selectedCctv?.id == cctv.id || isHighlighted;

    return Marker(
      key: ValueKey(cctv.id),
      point: LatLng(cctv.lat, cctv.lng),
      width: isSelected ? 56 : 44,
      height: isSelected ? 56 : 44,
      child: GestureDetector(
        onTap: () => _onMarkerTap(cctv),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 200),
          decoration: BoxDecoration(
            color: color.withOpacity(isSelected ? 0.3 : 0.2),
            shape: BoxShape.circle,
            border: Border.all(
              color: color,
              width: isSelected ? 3 : 2,
            ),
            boxShadow: [
              BoxShadow(
                color: color.withOpacity(0.4),
                blurRadius: isSelected ? 12 : 6,
                spreadRadius: isSelected ? 2 : 0,
              ),
            ],
          ),
          child: Center(
            child: Text(
              '${cctv.vehicles}',
              style: TextStyle(
                color: Colors.white,
                fontSize: isSelected ? 13 : 11,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
        ),
      ),
    );
  }

  /// Cluster badge color reflects the worst status among its markers, so
  /// a clustered jam is never hidden behind a neutral-colored bubble.
  Widget _buildClusterMarker(List<Marker> markers, Map<int, CctvStatus> cctvById) {
    String worstStatus = 'HIJAU';
    for (final m in markers) {
      final id = (m.key as ValueKey<int>).value;
      final status = cctvById[id]?.status.toUpperCase() ?? 'HIJAU';
      if (status == 'MERAH') {
        worstStatus = 'MERAH';
        break;
      }
      if (status == 'KUNING' && worstStatus != 'MERAH') {
        worstStatus = 'KUNING';
      }
    }
    final color = AppColors.statusColor(worstStatus);

    return Container(
      decoration: BoxDecoration(
        color: color.withOpacity(0.85),
        shape: BoxShape.circle,
        border: Border.all(color: Colors.white, width: 2),
        boxShadow: [BoxShadow(color: color.withOpacity(0.5), blurRadius: 8)],
      ),
      child: Center(
        child: Text(
          '${markers.length}',
          style: const TextStyle(color: Colors.white, fontSize: 13, fontWeight: FontWeight.w700),
        ),
      ),
    );
  }

  /// Draggable origin/destination pins: drop them anywhere to adjust the
  /// route — it refetches (with ETA) once the pin is released.
  List<DragMarker> _buildRoutePins(TrafficProvider provider, RouteProvider route) {
    DragMarker pin(LatLng point, IconData icon, Color color, {required bool isStart}) {
      return DragMarker(
        key: ValueKey('route-pin-${isStart ? 'start' : 'end'}'),
        point: point,
        size: const Size(44, 44),
        alignment: Alignment.topCenter,
        // Lift the pin above the finger while dragging so the drop spot
        // stays visible.
        dragOffset: const Offset(0, -32),
        builder: (context, pos, isDragging) => Icon(
          icon,
          color: color,
          size: isDragging ? 42 : 32,
          shadows: const [Shadow(color: Colors.black87, blurRadius: 6)],
        ),
        onDragEnd: (details, latLng) => route.moveEndpoint(
          start: isStart ? latLng : null,
          end: isStart ? null : latLng,
          cctvList: provider.cctvList,
          cityOnly: provider.filterRoadType == 'city',
        ),
      );
    }

    return [
      if (route.start != null)
        pin(route.start!, Icons.trip_origin, AppColors.hijau, isStart: true),
      if (route.end != null)
        pin(route.end!, Icons.place, AppColors.merah, isStart: false),
    ];
  }

  /// Non-interactive ETA pills above intermediate cameras ("+Xmnt · Ykm")
  /// and the destination ("📍 Xmnt · Ykm"), matching the website badges.
  List<Marker> _buildWaypointEtaBadges(RouteProvider route) {
    return route.waypointEtas.map((wp) {
      final label = wp.isDestination
          ? '📍 ${wp.segmentMin}mnt · ${wp.segmentKm}km'
          : '+${wp.segmentMin}mnt · ${wp.segmentKm}km';
      return Marker(
        point: wp.point,
        width: 130,
        height: 48,
        alignment: Alignment.topCenter,
        child: IgnorePointer(
          child: Align(
            alignment: Alignment.topCenter,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
              decoration: BoxDecoration(
                color: wp.isDestination
                    ? const Color(0xEB3B82F6)
                    : const Color(0xEB0F172A),
                borderRadius: BorderRadius.circular(999),
                border: Border.all(
                  color: wp.isDestination ? const Color(0xFF3B82F6) : const Color(0xFF475569),
                ),
                boxShadow: const [BoxShadow(color: Colors.black54, blurRadius: 6)],
              ),
              child: Text(
                label,
                style: const TextStyle(
                  color: Colors.white,
                  fontSize: 10,
                  fontWeight: FontWeight.w700,
                ),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ),
        ),
      );
    }).toList();
  }

  Widget _buildRouteHint() {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: AppColors.primary.withOpacity(0.15),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppColors.primary.withOpacity(0.5)),
      ),
      child: const Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.touch_app, color: AppColors.primary, size: 16),
          SizedBox(width: 8),
          Expanded(
            child: Text(
              'Titik asal dipilih — ketuk peta untuk tujuan (pin bisa digeser)',
              style: TextStyle(color: AppColors.primary, fontSize: 12, fontWeight: FontWeight.w600),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildEtaCard(RouteProvider route) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      decoration: BoxDecoration(
        color: AppColors.surface.withOpacity(0.95),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AppColors.divider),
      ),
      child: route.isLoading
          ? const Row(
              children: [
                SizedBox(
                  width: 14,
                  height: 14,
                  child: CircularProgressIndicator(color: AppColors.primary, strokeWidth: 2),
                ),
                SizedBox(width: 10),
                Text('Mencari rute...', style: TextStyle(color: AppColors.textSecondary, fontSize: 12)),
              ],
            )
          : route.error != null
              ? Row(
                  children: [
                    const Icon(Icons.error_outline, color: AppColors.merah, size: 16),
                    const SizedBox(width: 8),
                    const Expanded(
                      child: Text(
                        'Gagal mencari rute',
                        style: TextStyle(color: AppColors.textSecondary, fontSize: 12),
                      ),
                    ),
                    TextButton(
                      onPressed: route.retry,
                      style: TextButton.styleFrom(
                        padding: const EdgeInsets.symmetric(horizontal: 8),
                        minimumSize: Size.zero,
                      ),
                      child: const Text('Coba Lagi', style: TextStyle(fontSize: 12)),
                    ),
                    _etaCloseButton(route),
                  ],
                )
              : Row(
                  children: [
                    const Icon(Icons.directions_car, color: AppColors.primary, size: 18),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            '${route.etaMinutes ?? '-'} menit',
                            style: const TextStyle(
                              color: AppColors.textPrimary,
                              fontSize: 15,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                          Text(
                            '${route.distanceKm?.toStringAsFixed(1) ?? '-'} km • estimasi dgn traffic',
                            style: const TextStyle(color: AppColors.textMuted, fontSize: 11),
                          ),
                        ],
                      ),
                    ),
                    if (route.steps.isNotEmpty)
                      IconButton(
                        onPressed: () => _showRouteSteps(route),
                        icon: const Icon(Icons.list_alt, color: AppColors.primary, size: 20),
                        tooltip: 'Langkah rute',
                        padding: EdgeInsets.zero,
                        constraints: const BoxConstraints(minWidth: 36, minHeight: 36),
                      ),
                    _etaCloseButton(route),
                  ],
                ),
    );
  }

  Widget _etaCloseButton(RouteProvider route) {
    return IconButton(
      onPressed: route.clear,
      icon: const Icon(Icons.close, color: AppColors.textMuted, size: 18),
      tooltip: 'Hapus rute',
      padding: EdgeInsets.zero,
      constraints: const BoxConstraints(minWidth: 36, minHeight: 36),
    );
  }

  void _showRouteSteps(RouteProvider route) {
    showModalBottomSheet(
      context: context,
      backgroundColor: Colors.transparent,
      isScrollControlled: true,
      builder: (_) => _RouteStepsSheet(steps: route.steps),
    );
  }

  void _onMarkerTap(CctvStatus cctv) {
    context.read<TrafficProvider>().selectCctv(cctv);
    _mapController.move(LatLng(cctv.lat, cctv.lng), 15);
    _showCctvBottomSheet(cctv);
  }

  void _showCctvBottomSheet(CctvStatus cctv) {
    showModalBottomSheet(
      context: context,
      backgroundColor: Colors.transparent,
      isScrollControlled: true,
      builder: (_) => _CctvQuickView(cctv: cctv),
    );
  }

  Widget _buildStatsBar(TrafficProvider provider) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      decoration: BoxDecoration(
        color: AppColors.background.withOpacity(0.92),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AppColors.divider),
      ),
      child: Row(
        children: [
          const Icon(Icons.videocam, color: AppColors.primary, size: 18),
          const SizedBox(width: 8),
          Text(
            '${provider.totalCameras} Kamera',
            style: const TextStyle(color: AppColors.textPrimary, fontSize: 13, fontWeight: FontWeight.w600),
          ),
          const Spacer(),
          _statChip('🔴', provider.padatCount, AppColors.merah),
          const SizedBox(width: 8),
          _statChip('🟡', provider.ramaiCount, AppColors.kuning),
          const SizedBox(width: 8),
          _statChip('🟢', provider.lancarCount, AppColors.hijau),
        ],
      ),
    );
  }

  Widget _buildSearchBar(TrafficProvider provider) {
    return Container(
      height: 40,
      padding: const EdgeInsets.symmetric(horizontal: 12),
      decoration: BoxDecoration(
        color: AppColors.background.withOpacity(0.92),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppColors.divider),
      ),
      child: Row(
        children: [
          const Icon(Icons.search, color: AppColors.textMuted, size: 18),
          const SizedBox(width: 8),
          Expanded(
            child: TextField(
              controller: _searchController,
              onChanged: provider.setSearchQuery,
              style: const TextStyle(color: AppColors.textPrimary, fontSize: 13),
              decoration: const InputDecoration(
                isDense: true,
                border: InputBorder.none,
                hintText: 'Cari lokasi kamera...',
                hintStyle: TextStyle(color: AppColors.textMuted, fontSize: 13),
              ),
            ),
          ),
          if (provider.searchQuery.isNotEmpty)
            GestureDetector(
              onTap: () {
                _searchController.clear();
                provider.setSearchQuery('');
              },
              child: const Icon(Icons.close, color: AppColors.textMuted, size: 16),
            ),
        ],
      ),
    );
  }

  Widget _statChip(String emoji, int count, Color color) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: color.withOpacity(0.1),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Text(
        '$emoji $count',
        style: TextStyle(color: color, fontSize: 12, fontWeight: FontWeight.w600),
      ),
    );
  }

  Widget _buildFilterChips(TrafficProvider provider) {
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: Row(
        children: [
          _filterChip('Semua', provider.filterStatus == 'ALL',
              () => provider.setFilter(status: 'ALL')),
          _filterChip('🔴 Padat', provider.filterStatus == 'MERAH',
              () => provider.setFilter(status: 'MERAH')),
          _filterChip('🟡 Ramai', provider.filterStatus == 'KUNING',
              () => provider.setFilter(status: 'KUNING')),
          _filterChip('🟢 Lancar', provider.filterStatus == 'HIJAU',
              () => provider.setFilter(status: 'HIJAU')),
          const SizedBox(width: 8),
          _filterChip('🏙️ Kota', provider.filterRoadType == 'city',
              () => provider.setFilter(roadType: provider.filterRoadType == 'city' ? 'ALL' : 'city')),
          _filterChip('🛣️ Tol', provider.filterRoadType == 'toll',
              () => provider.setFilter(roadType: provider.filterRoadType == 'toll' ? 'ALL' : 'toll')),
          const SizedBox(width: 4),
          GestureDetector(
            onTap: () => StatusLegendSheet.show(context),
            child: Container(
              padding: const EdgeInsets.all(7),
              decoration: BoxDecoration(
                color: AppColors.background.withOpacity(0.85),
                shape: BoxShape.circle,
                border: Border.all(color: AppColors.divider),
              ),
              child: const Icon(Icons.info_outline, color: AppColors.textMuted, size: 15),
            ),
          ),
        ],
      ),
    );
  }

  Widget _filterChip(String label, bool selected, VoidCallback onTap) {
    return Padding(
      padding: const EdgeInsets.only(right: 6),
      child: GestureDetector(
        onTap: onTap,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 150),
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
          decoration: BoxDecoration(
            color: selected ? AppColors.primary.withOpacity(0.2) : AppColors.background.withOpacity(0.85),
            borderRadius: BorderRadius.circular(20),
            border: Border.all(
              color: selected ? AppColors.primary : AppColors.divider,
            ),
          ),
          child: Text(
            label,
            style: TextStyle(
              color: selected ? AppColors.primary : AppColors.textSecondary,
              fontSize: 12,
              fontWeight: selected ? FontWeight.w600 : FontWeight.w400,
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildBottomPanel(TrafficProvider provider) {
    final busiest = provider.busiestCamera;
    return Container(
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 20),
      decoration: BoxDecoration(
        color: AppColors.background.withOpacity(0.95),
        borderRadius: const BorderRadius.vertical(top: Radius.circular(20)),
        border: const Border(top: BorderSide(color: AppColors.divider)),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          // Handle
          Container(
            width: 40,
            height: 4,
            decoration: BoxDecoration(
              color: AppColors.divider,
              borderRadius: BorderRadius.circular(2),
            ),
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: _summaryTile(
                  Icons.directions_car,
                  'Total Kendaraan',
                  '${provider.totalVehicles}',
                  AppColors.primary,
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: _summaryTile(
                  Icons.warning_amber_rounded,
                  'Paling Padat',
                  busiest?.name ?? '-',
                  AppColors.merah,
                  subtitle: busiest != null ? '${busiest.vehicles} kendaraan' : null,
                ),
              ),
            ],
          ),
          if (provider.error != null) ...[
            const SizedBox(height: 8),
            Text(
              'Error: ${provider.error}',
              style: const TextStyle(color: AppColors.merah, fontSize: 11),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ],
        ],
      ),
    );
  }

  Widget _summaryTile(IconData icon, String title, String value, Color color, {String? subtitle}) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppColors.divider, width: 0.5),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(icon, size: 14, color: color),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  title,
                  style: const TextStyle(color: AppColors.textMuted, fontSize: 10),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            value,
            style: TextStyle(
              color: AppColors.textPrimary,
              fontSize: 14,
              fontWeight: FontWeight.w700,
            ),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
          if (subtitle != null)
            Text(
              subtitle,
              style: TextStyle(color: color, fontSize: 11),
            ),
        ],
      ),
    );
  }
}

// Quick view bottom sheet for tapped marker
class _CctvQuickView extends StatelessWidget {
  final CctvStatus cctv;

  const _CctvQuickView({required this.cctv});

  @override
  Widget build(BuildContext context) {
    final color = AppColors.statusColor(cctv.status);
    return Container(
      margin: const EdgeInsets.all(12),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: AppColors.divider),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              Container(
                width: 40,
                height: 40,
                decoration: BoxDecoration(
                  color: color.withOpacity(0.15),
                  shape: BoxShape.circle,
                ),
                child: Center(
                  child: Text(
                    '${cctv.vehicles}',
                    style: TextStyle(color: color, fontWeight: FontWeight.w700, fontSize: 14),
                  ),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      cctv.name,
                      style: const TextStyle(
                        color: AppColors.textPrimary,
                        fontWeight: FontWeight.w600,
                        fontSize: 15,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Row(
                      children: [
                        StatusBadge(status: cctv.status),
                        const SizedBox(width: 8),
                        Text(
                          cctv.isToll ? '🛣️ Tol' : '🏙️ Kota',
                          style: const TextStyle(color: AppColors.textMuted, fontSize: 11),
                        ),
                        const SizedBox(width: 8),
                        Text(
                          cctv.weather,
                          style: const TextStyle(color: AppColors.textMuted, fontSize: 11),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          // Risk bar
          Row(
            children: [
              const Text('Risk Score', style: TextStyle(color: AppColors.textMuted, fontSize: 11)),
              const SizedBox(width: 8),
              Expanded(
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(4),
                  child: LinearProgressIndicator(
                    value: cctv.riskScore / 100,
                    backgroundColor: AppColors.divider,
                    color: AppColors.riskColor(cctv.riskScore),
                    minHeight: 6,
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Text(
                '${cctv.riskScore}%',
                style: TextStyle(color: AppColors.riskColor(cctv.riskScore), fontSize: 12, fontWeight: FontWeight.w600),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

// Turn-by-turn route steps bottom sheet
class _RouteStepsSheet extends StatelessWidget {
  final List<RouteStep> steps;
  const _RouteStepsSheet({required this.steps});

  IconData _iconFor(RouteStep s) {
    if (s.type == 'depart') return Icons.trip_origin;
    if (s.type == 'arrive') return Icons.place;
    switch (s.modifier) {
      case 'left':
      case 'sharp left':
        return Icons.turn_left;
      case 'slight left':
        return Icons.turn_slight_left;
      case 'right':
      case 'sharp right':
        return Icons.turn_right;
      case 'slight right':
        return Icons.turn_slight_right;
      case 'uturn':
        return Icons.u_turn_left;
      default:
        return Icons.straight;
    }
  }

  String _distanceLabel(double m) =>
      m >= 1000 ? '${(m / 1000).toStringAsFixed(1)} km' : '${m.round()} m';

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.all(12),
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
      constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * 0.6),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: AppColors.divider),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'Langkah Rute',
            style: TextStyle(color: AppColors.textPrimary, fontSize: 16, fontWeight: FontWeight.w700),
          ),
          const SizedBox(height: 10),
          Flexible(
            child: ListView.separated(
              shrinkWrap: true,
              itemCount: steps.length,
              separatorBuilder: (_, __) => const Divider(color: AppColors.divider, height: 12),
              itemBuilder: (context, i) {
                final s = steps[i];
                return Row(
                  children: [
                    Icon(_iconFor(s), color: AppColors.primary, size: 20),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Text(
                        s.name.isEmpty ? '(jalan tanpa nama)' : s.name,
                        style: const TextStyle(color: AppColors.textPrimary, fontSize: 13),
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                    const SizedBox(width: 8),
                    Text(
                      _distanceLabel(s.distanceM),
                      style: const TextStyle(color: AppColors.textMuted, fontSize: 12),
                    ),
                  ],
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}
