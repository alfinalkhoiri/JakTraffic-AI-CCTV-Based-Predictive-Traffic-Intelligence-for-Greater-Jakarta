import 'package:flutter/material.dart';
import '../theme/app_theme.dart';

class StatusBadge extends StatelessWidget {
  final String status;
  final double? fontSize;
  final EdgeInsets? padding;

  const StatusBadge({
    super.key,
    required this.status,
    this.fontSize,
    this.padding,
  });

  @override
  Widget build(BuildContext context) {
    final color = AppColors.statusColor(status);
    final label = _label(status);

    return Container(
      padding: padding ?? const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: color.withOpacity(0.15),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: color.withOpacity(0.4), width: 1),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 6,
            height: 6,
            decoration: BoxDecoration(color: color, shape: BoxShape.circle),
          ),
          const SizedBox(width: 5),
          Text(
            label,
            style: TextStyle(
              color: color,
              fontSize: fontSize ?? 11,
              fontWeight: FontWeight.w600,
              letterSpacing: 0.5,
            ),
          ),
        ],
      ),
    );
  }

  String _label(String s) {
    switch (s.toUpperCase()) {
      case 'MERAH':
      case 'PADAT':
        return 'PADAT';
      case 'KUNING':
      case 'RAMAI':
      case 'SEDANG':
        return 'RAMAI';
      case 'HIJAU':
      case 'LANCAR':
        return 'LANCAR';
      default:
        return s.toUpperCase();
    }
  }
}
