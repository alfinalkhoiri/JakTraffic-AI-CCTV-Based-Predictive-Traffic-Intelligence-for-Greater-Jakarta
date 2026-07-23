import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:latlong2/latlong.dart';
import 'package:provider/provider.dart';

import 'models/map_action.dart';
import 'theme/app_theme.dart';
import 'providers/traffic_provider.dart';
import 'providers/chat_provider.dart';
import 'providers/prediction_provider.dart';
import 'providers/route_provider.dart';
import 'screens/home_screen.dart';
import 'screens/prediction_screen.dart';
import 'screens/chat_screen.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  SystemChrome.setSystemUIOverlayStyle(const SystemUiOverlayStyle(
    statusBarColor: Colors.transparent,
    statusBarIconBrightness: Brightness.light,
    systemNavigationBarColor: AppColors.background,
    systemNavigationBarIconBrightness: Brightness.light,
  ));
  runApp(const JakTrafficApp());
}

class JakTrafficApp extends StatelessWidget {
  const JakTrafficApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [
        ChangeNotifierProvider(create: (_) => TrafficProvider()),
        ChangeNotifierProvider(create: (_) => ChatProvider()),
        ChangeNotifierProvider(create: (_) => PredictionProvider()),
        ChangeNotifierProvider(create: (_) => RouteProvider()),
      ],
      child: MaterialApp(
        title: 'JakTraffic AI',
        debugShowCheckedModeBanner: false,
        theme: AppTheme.darkTheme,
        home: const MainNavigation(),
      ),
    );
  }
}

class MainNavigation extends StatefulWidget {
  const MainNavigation({super.key});

  @override
  State<MainNavigation> createState() => _MainNavigationState();
}

class _MainNavigationState extends State<MainNavigation> {
  int _currentIndex = 0;

  final _screens = const [
    HomeScreen(),
    PredictionScreen(),
    ChatScreen(),
  ];

  static const _wideBreakpoint = 640.0;
  static const _wideContentWidth = 480.0;

  /// Applies chatbot map commands to the map providers, then switches to the
  /// Peta tab so the user sees the result (the website shows the map and chat
  /// side by side; on mobile they're separate tabs).
  void _applyMapActions(List<MapAction> actions) {
    final traffic = context.read<TrafficProvider>();
    final route = context.read<RouteProvider>();
    final cctvList = traffic.allCctvList;

    for (final action in actions) {
      switch (action.type) {
        case 'select_pin':
          final target = cctvList.where((c) => c.id == action.locationId).firstOrNull;
          if (target != null) {
            route.clear(notify: false);
            traffic.setHighlightedIds(const []);
            traffic.selectCctv(target);
            traffic.requestFlyTo(LatLng(target.lat, target.lng), zoom: 15);
          }
        case 'highlight_pins':
          traffic.setHighlightedIds(action.locationIds);
          final first = cctvList.where((c) => c.id == action.locationIds.firstOrNull).firstOrNull;
          if (first != null) {
            traffic.requestFlyTo(LatLng(first.lat, first.lng), zoom: 13);
          }
        case 'fly_to':
          if (action.lat != null && action.lng != null) {
            traffic.requestFlyTo(LatLng(action.lat!, action.lng!), zoom: action.zoom ?? 14);
          }
        case 'set_route':
          if (action.startLat != null && action.endLat != null) {
            route.setRoute(
              LatLng(action.startLat!, action.startLng!),
              LatLng(action.endLat!, action.endLng!),
              cctvList,
              cityOnly: traffic.filterRoadType == 'city',
            );
          }
        case 'clear_selection':
          route.clear();
          traffic.clearChatSelections();
      }
    }
    setState(() => _currentIndex = 0);
  }

  @override
  Widget build(BuildContext context) {
    final pendingActions = context.watch<ChatProvider>().pendingMapActions;
    if (pendingActions != null) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        final actions = context.read<ChatProvider>().consumeMapActions();
        if (actions != null && actions.isNotEmpty) _applyMapActions(actions);
      });
    }

    return Scaffold(
      backgroundColor: AppColors.background,
      body: LayoutBuilder(
        builder: (context, constraints) {
          final body = IndexedStack(
            index: _currentIndex,
            children: _screens,
          );
          if (constraints.maxWidth <= _wideBreakpoint) return body;
          // Center()/Align() alone loosen the height constraint too, and the
          // Stack-based screens (e.g. HomeScreen's map) have no intrinsic
          // size, so they'd collapse to zero height. CrossAxisAlignment.stretch
          // guarantees the middle SizedBox gets a tight height instead.
          return Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Spacer(),
              SizedBox(width: _wideContentWidth, child: body),
              const Spacer(),
            ],
          );
        },
      ),
      bottomNavigationBar: LayoutBuilder(
        builder: (context, constraints) {
          final nav = Container(
            decoration: const BoxDecoration(
              border: Border(
                top: BorderSide(color: AppColors.divider, width: 0.5),
              ),
            ),
            child: BottomNavigationBar(
              currentIndex: _currentIndex,
              onTap: (i) => setState(() => _currentIndex = i),
              items: const [
                BottomNavigationBarItem(
                  icon: Icon(Icons.map_outlined),
                  activeIcon: Icon(Icons.map),
                  label: 'Peta',
                ),
                BottomNavigationBarItem(
                  icon: Icon(Icons.psychology_outlined),
                  activeIcon: Icon(Icons.psychology),
                  label: 'Prediksi',
                ),
                BottomNavigationBarItem(
                  icon: Icon(Icons.smart_toy_outlined),
                  activeIcon: Icon(Icons.smart_toy),
                  label: 'Chat AI',
                ),
              ],
            ),
          );
          if (constraints.maxWidth <= _wideBreakpoint) return nav;
          // Plain Center() expands to fill bounded constraints instead of
          // shrink-wrapping to the child's height (only unbounded constraints
          // shrink-wrap) — Scaffold measures bottomNavigationBar with a
          // bounded height, so without heightFactor this reports itself as
          // tall as the whole screen and starves body of space.
          return Center(
            heightFactor: 1.0,
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: _wideContentWidth),
              child: nav,
            ),
          );
        },
      ),
    );
  }
}
