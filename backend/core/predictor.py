"""
Traffic Prediction Model — Transformer Encoder
Memprediksi jumlah kendaraan 15 & 30 menit ke depan
berdasarkan data historis dari traffic_logs.
"""

import torch
import torch.nn as nn
import numpy as np
import math
import os
import logging

logger = logging.getLogger(__name__)

# =====================================================
# CONFIG
# =====================================================
SEQ_LEN = 60          # 60 data points terakhir (≈60 menit)
D_MODEL = 128          # dimensi model
N_HEADS = 8           # attention heads (harus D_MODEL % N_HEADS == 0)
N_LAYERS = 4          # encoder layers
D_FF = 128            # feedforward hidden dim
N_FEATURES = 6        # vehicles, hour_sin, hour_cos, min_sin, min_cos, day_of_week
DROPOUT = 0.1

MODEL_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "models")
MODEL_PATH = os.path.join(MODEL_DIR, "traffic_transformer.pt")


# =====================================================
# POSITIONAL ENCODING
# =====================================================
class PositionalEncoding(nn.Module):
    def __init__(self, d_model, max_len=200):
        super().__init__()
        pe = torch.zeros(max_len, d_model)
        position = torch.arange(0, max_len, dtype=torch.float).unsqueeze(1)
        div_term = torch.exp(torch.arange(0, d_model, 2).float() * (-math.log(10000.0) / d_model))
        pe[:, 0::2] = torch.sin(position * div_term)
        pe[:, 1::2] = torch.cos(position * div_term)
        pe = pe.unsqueeze(0)  # (1, max_len, d_model)
        self.register_buffer('pe', pe)

    def forward(self, x):
        return x + self.pe[:, :x.size(1), :]


# =====================================================
# TRANSFORMER MODEL
# =====================================================
class TrafficTransformer(nn.Module):
    def __init__(self, n_locations=8):
        super().__init__()

        self.input_proj = nn.Linear(N_FEATURES, D_MODEL)
        self.loc_embedding = nn.Embedding(n_locations + 1, D_MODEL)  # +1 for padding
        self.pos_encoder = PositionalEncoding(D_MODEL)

        encoder_layer = nn.TransformerEncoderLayer(
            d_model=D_MODEL,
            nhead=N_HEADS,
            dim_feedforward=D_FF,
            dropout=DROPOUT,
            batch_first=True
        )
        self.transformer = nn.TransformerEncoder(encoder_layer, num_layers=N_LAYERS)
        self.dropout = nn.Dropout(DROPOUT)

        # Output: prediksi 2 nilai (t+15, t+30)
        self.fc_out = nn.Sequential(
            nn.Linear(D_MODEL, D_FF),
            nn.ReLU(),
            nn.Dropout(DROPOUT),
            nn.Linear(D_FF, 2)  # [pred_15min, pred_30min]
        )

    def forward(self, x, loc_id):
        """
        x: (batch, seq_len, n_features)
        loc_id: (batch,) — integer location IDs
        """
        # Project input features to d_model
        x = self.input_proj(x)

        # Add location embedding
        loc_emb = self.loc_embedding(loc_id).unsqueeze(1)  # (batch, 1, d_model)
        x = x + loc_emb

        # Add positional encoding
        x = self.pos_encoder(x)
        x = self.dropout(x)

        # Transformer encoder
        out = self.transformer(x)

        # Use last timestep output for prediction
        last = out[:, -1, :]  # (batch, d_model)
        pred = self.fc_out(last)  # (batch, 2)

        return pred


# =====================================================
# FEATURE EXTRACTION
# =====================================================
def extract_features(vehicles, timestamp_str):
    """
    Dari (vehicles, timestamp) → feature vector [6]
    """
    from datetime import datetime

    try:
        # Handle multiple timestamp formats
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M:%S.%f"):
            try:
                dt = datetime.strptime(timestamp_str, fmt)
                break
            except ValueError:
                continue
        else:
            dt = datetime.now()
    except Exception:
        dt = datetime.now()

    hour = dt.hour + dt.minute / 60.0
    minute = dt.minute

    return [
        float(vehicles),
        math.sin(2 * math.pi * hour / 24),      # hour_sin
        math.cos(2 * math.pi * hour / 24),      # hour_cos
        math.sin(2 * math.pi * minute / 60),    # min_sin
        math.cos(2 * math.pi * minute / 60),    # min_cos
        dt.weekday() / 6.0                       # day_of_week normalized
    ]


# =====================================================
# PREDICTOR CLASS
# =====================================================
class TrafficPredictor:
    def __init__(self):
        self.model = None
        self.vehicle_max = 1.0
        self.device = torch.device("cpu")
        self._load_model()

    def _load_model(self):
        """Load trained model from disk"""
        if not os.path.exists(MODEL_PATH):
            logger.warning(f"Model file not found at {MODEL_PATH}. Run train_model.py first.")
            return

        try:
            checkpoint = torch.load(MODEL_PATH, map_location=self.device, weights_only=False)
            n_locations = checkpoint.get("n_locations", 8)
            self.vehicle_max = checkpoint.get("vehicle_max", 1.0)
            self.model = TrafficTransformer(n_locations=n_locations)
            self.model.load_state_dict(checkpoint["model_state_dict"])
            self.model._n_locations = n_locations   # simpan untuk clamp di predict()
            self.model.eval()
            logger.info(f"✅ Traffic Transformer model loaded (vehicle_max={self.vehicle_max}).")
        except Exception as e:
            logger.error(f"Failed to load model: {e}")
            self.model = None

    def predict(self, location_id, history_data):
        """
        Predict traffic for a location.

        Args:
            location_id: int, CCTV location ID
            history_data: list of (vehicles, timestamp_str) tuples,
                         ordered chronologically, last 60 entries

        Returns:
            dict: {"pred_15min": int, "pred_30min": int} or None
        """
        if self.model is None:
            return None

        if len(history_data) < 10:
            return None

        # Extract features
        features = []
        for vehicles, ts in history_data:
            features.append(extract_features(vehicles, ts))

        # Pad or truncate to SEQ_LEN
        if len(features) < SEQ_LEN:
            pad_len = SEQ_LEN - len(features)
            features = [features[0]] * pad_len + features
        else:
            features = features[-SEQ_LEN:]

        # Normalize vehicle counts (feature index 0) — same as training
        for f in features:
            f[0] = f[0] / self.vehicle_max

        # Convert to tensor
        # Clamp location_id ke range embedding model yang sudah dilatih (1-n_locations).
        # Lokasi baru (ID > n_locations) di-wrap agar tidak out-of-range.
        n_loc = getattr(self.model, '_n_locations', 8)
        safe_loc = ((location_id - 1) % n_loc) + 1
        x = torch.tensor([features], dtype=torch.float32)  # (1, seq_len, n_features)
        loc = torch.tensor([safe_loc], dtype=torch.long)

        with torch.no_grad():
            pred = self.model(x, loc)  # (1, 2)
            # Denormalize predictions
            pred_15 = max(0, int(round(pred[0, 0].item() * self.vehicle_max)))
            pred_30 = max(0, int(round(pred[0, 1].item() * self.vehicle_max)))

        return {"pred_15min": pred_15, "pred_30min": pred_30}
