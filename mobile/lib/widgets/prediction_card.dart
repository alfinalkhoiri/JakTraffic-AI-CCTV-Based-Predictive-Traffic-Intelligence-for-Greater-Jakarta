import 'package:flutter/material.dart';
import '../theme/app_theme.dart';
import '../models/prediction.dart';
import 'status_badge.dart';

class PredictionCard extends StatelessWidget {
  final Prediction prediction;
  final VoidCallback? onTap;

  const PredictionCard({
    super.key,
    required this.prediction,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final color = AppColors.statusColor(prediction.status);
    final isUp = prediction.delta > 0;
    final changeText = isUp
        ? '+${prediction.changePct.toStringAsFixed(1)}%'
        : '${prediction.changePct.toStringAsFixed(1)}%';

    return GestureDetector(
      onTap: onTap,
      child: Container(
        margin: const EdgeInsets.only(bottom: 8),
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: color.withOpacity(0.2)),
        ),
        child: Row(
          children: [
            // Status indicator
            Container(
              width: 4,
              height: 48,
              decoration: BoxDecoration(
                color: color,
                borderRadius: BorderRadius.circular(2),
              ),
            ),
            const SizedBox(width: 12),
            // Info
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    prediction.name,
                    style: const TextStyle(
                      color: AppColors.textPrimary,
                      fontWeight: FontWeight.w600,
                      fontSize: 14,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Row(
                    children: [
                      Text(
                        '${prediction.currentVehicles}',
                        style: const TextStyle(
                          color: AppColors.textSecondary,
                          fontSize: 12,
                        ),
                      ),
                      const Padding(
                        padding: EdgeInsets.symmetric(horizontal: 6),
                        child: Icon(Icons.arrow_forward, size: 12, color: AppColors.textMuted),
                      ),
                      Text(
                        '${prediction.predictedVehicles}',
                        style: TextStyle(
                          color: color,
                          fontSize: 14,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      const SizedBox(width: 6),
                      Text(
                        'kendaraan',
                        style: TextStyle(
                          color: AppColors.textMuted,
                          fontSize: 11,
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
            // Change indicator + badge
            Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                StatusBadge(status: prediction.status),
                const SizedBox(height: 6),
                Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(
                      isUp ? Icons.trending_up : Icons.trending_down,
                      size: 14,
                      color: isUp ? AppColors.merah : AppColors.hijau,
                    ),
                    const SizedBox(width: 3),
                    Text(
                      changeText,
                      style: TextStyle(
                        color: isUp ? AppColors.merah : AppColors.hijau,
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
