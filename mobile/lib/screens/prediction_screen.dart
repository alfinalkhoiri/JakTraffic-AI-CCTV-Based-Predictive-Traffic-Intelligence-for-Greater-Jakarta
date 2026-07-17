import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../providers/prediction_provider.dart';
import '../theme/app_theme.dart';
import '../widgets/error_state.dart';
import '../widgets/prediction_card.dart';
import '../widgets/shimmer_placeholder.dart';
import '../widgets/status_legend_sheet.dart';

class PredictionScreen extends StatefulWidget {
  const PredictionScreen({super.key});

  @override
  State<PredictionScreen> createState() => _PredictionScreenState();
}

class _PredictionScreenState extends State<PredictionScreen> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      context.read<PredictionProvider>().fetchPredictions();
    });
  }

  @override
  Widget build(BuildContext context) {
    return Consumer<PredictionProvider>(
      builder: (context, provider, _) {
        return Scaffold(
          backgroundColor: AppColors.background,
          body: SafeArea(
            child: Column(
              children: [
                // Header
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Container(
                            padding: const EdgeInsets.all(10),
                            decoration: BoxDecoration(
                              color: AppColors.primary.withOpacity(0.1),
                              borderRadius: BorderRadius.circular(12),
                            ),
                            child: const Icon(Icons.psychology, color: AppColors.primary, size: 22),
                          ),
                          const SizedBox(width: 12),
                          const Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  'Prediksi AI',
                                  style: TextStyle(
                                    color: AppColors.textPrimary,
                                    fontSize: 20,
                                    fontWeight: FontWeight.w700,
                                  ),
                                ),
                                Text(
                                  'Transformer Neural Network',
                                  style: TextStyle(color: AppColors.textMuted, fontSize: 12),
                                ),
                              ],
                            ),
                          ),
                          IconButton(
                            onPressed: () => StatusLegendSheet.show(context),
                            icon: const Icon(Icons.info_outline, color: AppColors.textMuted),
                          ),
                          IconButton(
                            onPressed: () => provider.fetchPredictions(),
                            icon: const Icon(Icons.refresh, color: AppColors.primary),
                          ),
                        ],
                      ),
                      const SizedBox(height: 14),
                      // Horizon toggle
                      Container(
                        padding: const EdgeInsets.all(4),
                        decoration: BoxDecoration(
                          color: AppColors.surface,
                          borderRadius: BorderRadius.circular(12),
                        ),
                        child: Row(
                          children: [
                            _horizonTab('15 Menit', '15', provider),
                            _horizonTab('30 Menit', '30', provider),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),

                // Summary stats
                if (!provider.isLoading && provider.predictions.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                    child: Row(
                      children: [
                        _summaryChip('🔴 Padat', provider.padatCount, AppColors.merah),
                        const SizedBox(width: 8),
                        _summaryChip('🟡 Ramai', provider.ramaiCount, AppColors.kuning),
                        const SizedBox(width: 8),
                        _summaryChip('🟢 Lancar', provider.lancarCount, AppColors.hijau),
                      ],
                    ),
                  ),

                // List
                Expanded(
                  child: _buildContent(provider),
                ),
              ],
            ),
          ),
        );
      },
    );
  }

  Widget _horizonTab(String label, String value, PredictionProvider provider) {
    final selected = provider.horizon == value;
    return Expanded(
      child: GestureDetector(
        onTap: () => provider.setHorizon(value),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 200),
          padding: const EdgeInsets.symmetric(vertical: 10),
          decoration: BoxDecoration(
            color: selected ? AppColors.primary : Colors.transparent,
            borderRadius: BorderRadius.circular(10),
          ),
          child: Center(
            child: Text(
              label,
              style: TextStyle(
                color: selected ? AppColors.background : AppColors.textMuted,
                fontWeight: FontWeight.w600,
                fontSize: 13,
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _summaryChip(String label, int count, Color color) {
    return Expanded(
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 10),
        decoration: BoxDecoration(
          color: color.withOpacity(0.08),
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: color.withOpacity(0.2)),
        ),
        child: Column(
          children: [
            Text(
              '$count',
              style: TextStyle(color: color, fontSize: 20, fontWeight: FontWeight.w700),
            ),
            Text(label, style: TextStyle(color: color.withOpacity(0.8), fontSize: 11)),
          ],
        ),
      ),
    );
  }

  Widget _buildContent(PredictionProvider provider) {
    if (provider.isLoading) {
      return const ShimmerListSkeleton(count: 5, itemHeight: 84);
    }
    if (provider.error != null) {
      return ErrorState(error: provider.error, onRetry: () => provider.fetchPredictions());
    }
    if (provider.predictions.isEmpty) {
      return const Center(
        child: Text('Tidak ada data prediksi', style: TextStyle(color: AppColors.textMuted)),
      );
    }

    return RefreshIndicator(
      color: AppColors.primary,
      onRefresh: () => provider.fetchPredictions(),
      child: ListView.builder(
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 80),
        itemCount: provider.predictions.length,
        itemBuilder: (context, index) {
          final pred = provider.predictions[index];
          return PredictionCard(prediction: pred);
        },
      ),
    );
  }
}
