import 'package:flutter/material.dart';
import 'package:shimmer/shimmer.dart';
import '../theme/app_theme.dart';

/// Single shimmering rounded-rect placeholder, sized like a list card.
class ShimmerCard extends StatelessWidget {
  final double height;
  final EdgeInsetsGeometry margin;

  const ShimmerCard({
    super.key,
    this.height = 76,
    this.margin = const EdgeInsets.only(bottom: 12),
  });

  @override
  Widget build(BuildContext context) {
    return Shimmer.fromColors(
      baseColor: AppColors.surface,
      highlightColor: AppColors.surfaceLight,
      child: Container(
        height: height,
        margin: margin,
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(12),
        ),
      ),
    );
  }
}

/// A scrollable list of [ShimmerCard]s, used in place of a bare spinner
/// while a screen's data is loading.
class ShimmerListSkeleton extends StatelessWidget {
  final int count;
  final double itemHeight;
  final EdgeInsetsGeometry padding;

  const ShimmerListSkeleton({
    super.key,
    this.count = 4,
    this.itemHeight = 76,
    this.padding = const EdgeInsets.all(16),
  });

  @override
  Widget build(BuildContext context) {
    return ListView.builder(
      padding: padding,
      itemCount: count,
      itemBuilder: (_, __) => ShimmerCard(height: itemHeight),
    );
  }
}
