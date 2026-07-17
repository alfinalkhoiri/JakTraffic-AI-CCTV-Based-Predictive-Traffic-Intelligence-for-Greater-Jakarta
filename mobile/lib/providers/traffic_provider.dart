import 'dart:async';
import 'package:flutter/material.dart';
import 'package:latlong2/latlong.dart';
import '../models/cctv_status.dart';
import '../services/traffic_service.dart';

class TrafficProvider extends ChangeNotifier {
  List<CctvStatus> _cctvList = [];
  CctvStatus? _selectedCctv;
  bool _isLoading = false;
  String? _error;
  Timer? _refreshTimer;
  String _filterStatus = 'ALL'; // ALL, HIJAU, KUNING, MERAH
  String _filterRoadType = 'ALL'; // ALL, city, toll
  String _searchQuery = '';

  List<CctvStatus> get cctvList => _filteredList;
  List<CctvStatus> get allCctvList => _cctvList;
  CctvStatus? get selectedCctv => _selectedCctv;
  bool get isLoading => _isLoading;
  String? get error => _error;
  String get filterStatus => _filterStatus;
  String get filterRoadType => _filterRoadType;
  String get searchQuery => _searchQuery;

  List<CctvStatus> get _filteredList {
    return _cctvList.where((c) {
      if (_filterStatus != 'ALL' && c.status.toUpperCase() != _filterStatus) {
        return false;
      }
      if (_filterRoadType != 'ALL' && c.roadType != _filterRoadType) {
        return false;
      }
      if (_searchQuery.isNotEmpty &&
          !c.name.toLowerCase().contains(_searchQuery.toLowerCase())) {
        return false;
      }
      return true;
    }).toList();
  }

  // Stats
  int get totalVehicles => _cctvList.fold(0, (sum, c) => sum + c.vehicles);
  int get totalCameras => _cctvList.length;
  int get padatCount => _cctvList.where((c) => c.status == 'MERAH').length;
  int get ramaiCount => _cctvList.where((c) => c.status == 'KUNING').length;
  int get lancarCount => _cctvList.where((c) => c.status == 'HIJAU').length;
  CctvStatus? get busiestCamera =>
      _cctvList.isEmpty ? null : _cctvList.reduce((a, b) => a.vehicles > b.vehicles ? a : b);

  void setFilter({String? status, String? roadType}) {
    if (status != null) _filterStatus = status;
    if (roadType != null) _filterRoadType = roadType;
    notifyListeners();
  }

  void setSearchQuery(String query) {
    _searchQuery = query;
    notifyListeners();
  }

  void selectCctv(CctvStatus? cctv) {
    _selectedCctv = cctv;
    notifyListeners();
  }

  // ── Chatbot map-command support ──────────────────────────────────────
  Set<int> _highlightedIds = {};
  LatLng? _flyToTarget;
  double _flyToZoom = 13;

  /// Camera ids the chatbot asked to highlight (blue ring on the map).
  Set<int> get highlightedIds => _highlightedIds;
  LatLng? get flyToTarget => _flyToTarget;
  double get flyToZoom => _flyToZoom;

  void setHighlightedIds(Iterable<int> ids) {
    _highlightedIds = ids.toSet();
    notifyListeners();
  }

  void requestFlyTo(LatLng target, {double zoom = 13}) {
    _flyToTarget = target;
    _flyToZoom = zoom;
    notifyListeners();
  }

  /// Called by the map screen after it has moved the camera.
  void consumeFlyTo() {
    _flyToTarget = null;
  }

  void clearChatSelections() {
    _highlightedIds = {};
    _selectedCctv = null;
    notifyListeners();
  }

  Future<void> fetchData() async {
    _isLoading = true;
    _error = null;
    notifyListeners();

    try {
      _cctvList = await TrafficService.fetchCctvStatus();
      _error = null;
    } catch (e) {
      _error = e.toString();
    }

    _isLoading = false;
    notifyListeners();
  }

  void startAutoRefresh({Duration interval = const Duration(minutes: 2)}) {
    _refreshTimer?.cancel();
    _refreshTimer = Timer.periodic(interval, (_) => fetchData());
  }

  void stopAutoRefresh() {
    _refreshTimer?.cancel();
    _refreshTimer = null;
  }

  @override
  void dispose() {
    _refreshTimer?.cancel();
    super.dispose();
  }
}
