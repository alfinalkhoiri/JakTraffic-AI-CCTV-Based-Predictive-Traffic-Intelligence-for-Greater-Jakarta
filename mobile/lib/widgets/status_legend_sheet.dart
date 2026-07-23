import 'package:flutter/material.dart';
import '../theme/app_theme.dart';

/// Bottom sheet explaining what the traffic status colors mean.
/// Deliberately qualitative (no vehicle-count numbers) since the backend
/// derives status from a combined vehicle+weather score that differs by
/// feature (live status vs. prediction vs. signal recommendation).
class StatusLegendSheet extends StatelessWidget {
  const StatusLegendSheet({super.key});

  static void show(BuildContext context) {
    showModalBottomSheet(
      context: context,
      backgroundColor: Colors.transparent,
      builder: (_) => const StatusLegendSheet(),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.all(12),
      padding: const EdgeInsets.all(20),
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
            'Keterangan Warna',
            style: TextStyle(color: AppColors.textPrimary, fontSize: 16, fontWeight: FontWeight.w700),
          ),
          const SizedBox(height: 16),
          _row('🟢', 'Lancar', 'Arus normal, tidak ada hambatan berarti', AppColors.hijau),
          const SizedBox(height: 12),
          _row('🟡', 'Ramai', 'Kepadatan meningkat, waspada', AppColors.kuning),
          const SizedBox(height: 12),
          _row('🔴', 'Padat', 'Kemacetan signifikan, disarankan cari rute alternatif', AppColors.merah),
          const SizedBox(height: 8),
        ],
      ),
    );
  }

  Widget _row(String emoji, String title, String desc, Color color) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Container(
          width: 32,
          height: 32,
          decoration: BoxDecoration(color: color.withOpacity(0.15), shape: BoxShape.circle),
          child: Center(child: Text(emoji, style: const TextStyle(fontSize: 16))),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(title, style: TextStyle(color: color, fontWeight: FontWeight.w700, fontSize: 14)),
              const SizedBox(height: 2),
              Text(desc, style: const TextStyle(color: AppColors.textSecondary, fontSize: 12)),
            ],
          ),
        ),
      ],
    );
  }
}
